# @artfluence/venue-image-contract

The single shared answer to **"which of this venue review's picks can no longer be served?"**

## Why this is a package

Two consumers must agree exactly:

- the **city-scraper** image fold decides what a venue **serves**
- the **command-center** Picture Verifier decides what re-enters the review **queue**

When they disagree, a venue is broken in the app while the console still calls it reviewed. Detecting that drift after the fact is not good enough, so the rule lives in one place both import, rather than being copied into each with a checksum to compare. A checksum only ever sees one side; a shared implementation removes the failure mode instead of reporting it.

## The rule

Venue image picks reference Google Places photos by an opaque `photoName`, and those references expire on roughly a 30-day cadence. A scheduled renewal re-issues them, and records the ones it could not:

```js
photoNamesUnmatched: [{ path: "gallery.1", photoName: "places/…/photos/…/media", reason: "ambiguous_old" }]
```

Google answers an expired reference with `400 INVALID_ARGUMENT`, which the API surfaces as `502`. Those entries are not photos any more.

**A path counts as dead only while the pick still carries the exact `photoName` the renewal failed on.** That pin is load-bearing: the console does not clear `photoNamesUnmatched` when an operator re-picks, so without it a stale marker would suppress a brand-new image. Pinning the name makes the marker self-invalidating — no cleanup job, no cross-service coordination.

Paths address picks by **array position** (`primary`, `gallery.<i>`), never by the pick's `order` field. `order` is the operator's display ordering; measured against real data, it agrees with array position barely more often than chance.

## Url-keyed picks rot too

Picks sourced from a site, added manually, or taken from Wikipedia are keyed by **url**, and a url dies its own way: the page 404s, the CDN path moves, the domain lapses, the host starts answering 403. A url-liveness detector records those in a marker of its own:

```js
urlPicksUnmatched: [{ path: "primary", url: "https://venue.example/hero.jpg", source: "site", reason: "url_gone" }]
```

**A second field, not a second use of the first.** `renew-photo-names` rewrites `photoNamesUnmatched` **wholesale** on every run — it computes the google verdict for the whole document and replaces the array. Writing url findings there would have the next renewal silently erase them. `photoNamesUnmatched` stays google-only for exactly that reason.

`url` is required, non-empty and **protocol-shaped** (`http://` or `https://`): it is the pin. The match rule mirrors the google one, through the same keying function a live document is read with:

```js
pickRef(pickAtPath(review, entry.path)) === entry.url   // and entry.url is http(s)-shaped
```

Going through `pickRef` rather than reading `pick.url` is what keeps the halves from overlapping. A **google** pick is addressed by its `photoName`, so the url sitting beside that name — a rendering that changes on every renewal — can never pin it dead. And the entry self-invalidates exactly as the google one does: re-pick, and the pin stops matching.

The shape gate closes the other side of that door. `pickRef` of a google pick **is** its photoName, so a marker that writes a photoName into its `url` field compares equal — it would kill a perfectly healthy google pick and file it under `url`, where triage can only ask for a manual re-pick. A photoName is not a url, whatever field it is written in. The gate also fails **safe**: a url of any unrecognised shape (scheme-less, protocol-relative, `data:`, `ftp:`) leaves its pick **alive**, because a marker is a claim that a fetchable asset is gone and an unrecognised shape is not evidence of that.

`source` on an entry is a triage hint and takes **no** part in the match — a stale or missing tag must never resurrect a dead pick. `reason` is documentation; see below.

**One writer.** `urlPicksUnmatched` is to be written only by the url-liveness detector, through a dedicated shape in the city-scraper write-guard — *planned*, landing with the detector. This contract ships first so both sides are built against one definition. The Command Center reads it and re-picks; it never writes it. Neither marker has a clear step or a cleanup job, because neither needs one: an entry counts only while the pick it names still carries the reference it died on, so healing the pick retires the entry in the same write.

## Which death, and what repairs it

`deadPickPaths` unions the two. `deadPickPathsByKind` keeps them apart, because the two deaths have different repairs:

```js
const { google, url } = deadPickPathsByKind(review)
```

| kind | what died | the repair |
|---|---|---|
| `google` | the photo *reference* expired; the photo still exists in Places | a **repick proposal** can be computed and offered |
| `url` | the *asset* is gone | only an operator **re-picking in the grid** |

A triage UI that cannot tell them apart offers a proposal it can never fulfil. A path dead **both** ways — a hybrid pick carrying a marked `photoName` and a marked `url` — is in **both** sets; each consumer must see it. The union of the two is exactly `deadPickPaths`, which counts it once.

## The reason vocabularies

```js
GOOGLE_UNMATCHED_REASONS  // frozen ["ambiguous_old", "ambiguous_fresh", "no_fresh_match",
                          //         "no_fingerprint", "divergent_duplicates", "invalid_fresh_target"]
GOOGLE_FETCH_ERROR_REASON_PREFIX  // "fetch_error:"
URL_DEAD_REASONS          // frozen ["url_gone", "url_moved", "url_host_dead", "url_forbidden"]
URL_DEAD_REASON_PREFIX    // "url_"
```

| reason | means |
|---|---|
| `ambiguous_old` | several old photos fingerprint alike — which one this pick was is unknowable |
| `ambiguous_fresh` | several fresh photos match the old one equally well |
| `no_fresh_match` | the place still has photos, none of them this one |
| `no_fingerprint` | the old reference could not be fetched to fingerprint at all |
| `divergent_duplicates` | duplicate picks of one photo renewed to different fresh references |
| `invalid_fresh_target` | the fresh reference the renewal computed does not itself resolve |
| `fetch_error:<detail>` | a transport failure — `fetch_error:ETIMEDOUT`, `fetch_error:503`, … |
| `url_gone` | the url resolves and answers 404/410 — the asset is not there any more |
| `url_moved` | it redirects somewhere that is no longer this image (a homepage, a 404 page) |
| `url_host_dead` | the host does not resolve or does not answer at all — a **persistent**, NXDOMAIN-class death, established over time, never a bad hour |
| `url_forbidden` | the host answers 401/403 — reachable, but not servable to us |

The google list is **not exhaustive**: `fetch_error:` carries a suffix, so a consumer switching on the list alone drops every transport failure. Match the prefix too. Every url reason carries `url_`, which is how a mixed triage screen routes by kind without knowing either list.

### Inconclusive is not dead

Every url reason is a **verdict**, not a probe result. An **inconclusive** probe — a timeout, a connection reset, a 5xx, a transport abort — must **not** be written as a mark at all. It is not evidence that an asset is gone; it is evidence that one attempt failed, and a marker written from it takes a live image off a venue because a CDN had a bad minute.

That is why this list has **no open-ended transport member** mirroring the google side's `fetch_error:<detail>`, and the asymmetry is deliberate:

| | what the failure means |
|---|---|
| google `fetch_error:<detail>` | the **renewal** could not be completed — a real outcome for that job, and the pick genuinely has no fresh reference |
| a url probe that fails to complete | **no outcome at all** — the asset's liveness is simply unknown |

Inconclusive results belong to the detector's own **suspect machinery** — repeat, corroborate, age — and reach this field only once they have hardened into one of the four verdicts. `url_host_dead` in particular means a persistent, NXDOMAIN-class death established over time, not one failed lookup.

This doctrine binds the **detector** and is enforced there. Nothing in this package validates it: a marker with any reason at all still marks its path dead, which is exactly why the detector must not write one it cannot stand behind.

**Documentation, not validation.** Nothing here checks a reason against either list, and an entry with an unknown, empty or absent reason still marks its path dead. A validator would only turn a newly-minted reason into a silently-ignored marker — the detector would go on reporting while the fold quietly stopped listening.

## The provider vocabulary

Where a venue image came from, spelled the one way a seed file writes it, a live venue document stores it, and the API wire carries it:

```js
VENUE_IMAGE_PROVIDERS // frozen ["google_places", "site", "manual", "wikipedia"]
```

This is **not** the ops-console **source** vocabulary. The Command Center's operator-facing picker says `google` / `site` / `manual` / `wikipedia`, and its `google` maps onto `google_places`; the other three match. A consumer crossing between the two must map, never assume the spellings agree.

The list is frozen and its order is part of the contract — consumers echo it in enum declarations and validation messages.

It lives here because on **2026-08-17 the brussels promote died on a stray fourth copy** of it (control-center#105). Three copies were being kept in step by hand; the fourth was not, and it rejected a provider the others accepted. A copied vocabulary drifts exactly like a copied rule, so it now sits beside the rule.

## API

```js
const {
  deadPickPaths, deadPickPathsByKind, liveImageRef, pickAtPath, pickRef, pictureState,
  queueDeadPickPaths, VENUE_IMAGE_PROVIDERS,
  GOOGLE_UNMATCHED_REASONS, GOOGLE_FETCH_ERROR_REASON_PREFIX, URL_DEAD_REASONS, URL_DEAD_REASON_PREFIX,
} = require("@artfluence/venue-image-contract")

deadPickPaths(review)                  // Set<"primary" | "gallery.<i>"> — dead by EITHER marker
deadPickPathsByKind(review)            // { google: Set<path>, url: Set<path> } — same verdict, split by why
pickAtPath(review, path)               // ImagePick | null
pickRef(pick)                          // string | null — the ref a review pick is addressed by
liveImageRef(img)                      // string | null — the ref a LIVE doc entry is addressed by
pictureState(review)                   // { state, dead, survivingGalleryPaths, primaryDead }
queueDeadPickPaths(review, shownRefs)  // Set<path> — the dead paths a QUEUE should still act on
VENUE_IMAGE_PROVIDERS                  // readonly ["google_places", "site", "manual", "wikipedia"]
GOOGLE_UNMATCHED_REASONS               // readonly — plus the open-ended `fetch_error:<detail>`
URL_DEAD_REASONS                       // readonly — every one prefixed `url_`
```

`pictureState` and `queueDeadPickPaths` read `deadPickPaths`, so both inherit url-dead with no change of their own: a url-dead primary folds to `stale` or `none` exactly as a google-dead one does, and queues on a promoted venue exactly as one does.

`pictureState` returns the same question phrased for each consumer:

| state | serves | review queue |
|---|---|---|
| `ok` | the operator's picks | out |
| `stale` | the surviving pick | **in** — needs a re-pick |
| `none` | nothing | **in** — needs sourcing |

`stale` and `none` are deliberately distinct: they are different jobs. A `stale` venue still shows an image; a `none` venue shows nothing and needs a source found.

## Dead picks on a promoted venue

Once a venue is **promoted**, its live document — not the review — decides what users see. A review can hold dead picks the live venue never adopted, or dropped long ago. Queueing those asks an operator to re-pick an image nobody is looking at, and blocks the promote gate on a defect with no user-visible symptom.

`queueDeadPickPaths(review, shownRefs)` narrows `deadPickPaths` to the dead picks the live venue **actually shows**:

```js
const shownRefs = liveVenue
  ? new Set([liveVenue.image, ...(liveVenue.images || [])].map(liveImageRef).filter(Boolean))
  : null

queueDeadPickPaths(review, shownRefs)
```

Both `image` and `images`: the hero is a field of its own, and a document whose `images` array is missing or trimmed still shows it.

| `shownRefs` | means | result |
|---|---|---|
| `null` / `undefined` | not promoted, or the live doc could not be loaded | **every** dead path — fails open |
| `new Set()` | promoted and tombstoned: a live doc with no image | **nothing** — there is nothing on screen to repair |
| a set of refs | promoted, showing these | only the dead paths whose pick is among them |

Each side has its own keying function, because each side has its own vocabulary:

| | reads | google is spelled | google → | everything else → |
|---|---|---|---|---|
| `pickRef(pick)` | a review pick | `google` (ops-console **source**) | `photoName` | `url` |
| `liveImageRef(img)` | a live document entry | `google_places` (**provider**) | `photoName` | `url` |

They return the same string for the same photo, because the fold copies `photoName` and `url` onto a live entry verbatim. Neither accepts the other's spelling: `pickRef` on a `google_places`-tagged pick, or `liveImageRef` on a `google`-tagged entry, is a vocabulary mix-up and returns `null` rather than guessing.

A google image is never addressed by a url beside it — its identity is the photoName, and a url next to it is a rendering that changes on every renewal. Keying a live entry as `photoName ?? url` agrees for every shape a real entry takes, but disagrees on one carrying both, so use `liveImageRef`.

**Anything that is not an iterable of ref strings fails open.** A `Map` (which yields `[key, value]` pairs), a list of live entries someone forgot to key, a list with one stray blank — all read as "no live document", not as "shows nothing". Reading a wrongly-filled container as a tombstone would suppress a venue's whole queue in silence, which is the one outcome suppression must never reach by accident.

Suppression is meaningful because a live document only changes when the venue is **promoted**: a reference that died after the last promote is still on screen, so it is queued; one the live document never adopted, or dropped at an earlier promote, is not.

**This is a queue-side predicate only.** It must never feed the image fold or `pictureState`. Those compute what a venue *serves*, and `shownRefs` is derived from that same output — routing it back makes the fold's input depend on its own output, and the promoted venue re-serves the dead reference. Serving reads `deadPickPaths`; the review queue and the promote gate read `queueDeadPickPaths`.

## Consuming it

```json
{ "dependencies": { "@artfluence/venue-image-contract": "github:artfluence/venue-image-contract#v1.3.0" } }
```

No registry, no publish step. Pin a tag — an unpinned dependency reintroduces drift by the back door.

## Changing the rule

The rule is expected to **grow**, and at `v1.3.0` it did: as venue imagery moved off Google-hosted references toward other sources, "dead" broadened from "unmatched photo reference" to "asset unavailable" across several providers.

Growth is **additive**. `v1.3.0` added a branch, an export and a vocabulary; it changed no answer for a document that carries only the google marker, and the seven `v1.2.0` exports keep their names, kinds and meanings. A consumer bumps to gain url-dead, never to keep working.

Extend it here, tag a new version, and bump each consumer deliberately. A consumer that has not bumped keeps the old meaning — visibly, in its `package.json`, rather than silently.

The next marker, whatever it keys on, follows the same doctrine: **its own field** (a writer that replaces its array must not be able to erase another's findings), **its own pin** through `pickRef` (so the entry self-invalidates on a re-pick and needs no cleanup job), and **its own kind** in `deadPickPathsByKind` when its repair differs.

## Repository rules

`prod` is the only long-lived branch and the default. Changes land by squash-merged pull request; only an admin can merge or bypass.
