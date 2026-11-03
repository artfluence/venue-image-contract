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
  normalizePinFocus, parsePinFocus, pinFocusKey, pinCropRect, pinFocusScaleCap,
  PIN_FOCUS_SCALE_MIN, PIN_FOCUS_SCALE_MAX,
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
normalizePinFocus(input)               // NormalizedPinFocus | null — STORED values; default and garbage → null
parsePinFocus(input)                   // { ok: true, focus } | { ok: false, reason } — WRITERS; refuses garbage
pinFocusKey(focus)                     // "" | "f:x,y,scale" — the focal's cache-key fragment
pinCropRect(width, height, focus)      // { left, top, side } — the pin's square, integer px
pinFocusScaleCap(width, height, minPx) // number in [1, 3] — the zoom that still cuts ≥ minPx source px
PIN_FOCUS_SCALE_MIN / _MAX             // 1 / 3
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

## Pin focus (v1.4.0)

A venue's map pin is a circle cut from its cover photo. Ops choose **where** on the photo it is cut — a per-photo focal point set in the Command Center. The focal describes one photo: it rides the approved pick as `ImagePick.pinFocus`, the folds carry it into the seed and the promote into the live venue's `image` / `images[]` entry (`VenueImageLike.pinFocus`).

```js
pinFocus: { x: 0.25, y: 0.6, scale: 2 }   // absent or null = the centred square at scale 1
```

| field | range | rounding | absent |
|---|---|---|---|
| `x`, `y` | `[0, 1]` of the **oriented** image | 3 dp | required |
| `scale` | `[1, 3]` — the square's side is the short side ÷ `scale` | 2 dp | `1` |

Rounding is `Math.round(v · 10^p) / 10^p` — half-up on the number, never `toFixed` (which returns a string and rounds the binary value).

**Orientation.** `x` / `y` refer to the **oriented** image — after EXIF auto-orient, the photo as a browser shows it. The API must take the dimensions it cuts in from sharp's `metadata().autoOrient` (not the raw `width` / `height`, which are pre-rotation), and the CC editor shows the oriented photo, as browsers do by default. A pin cut in raw space from a focal set in oriented space lands on the wrong part of a rotated photo.

**The focal stays with its photo — the writer's obligation.** A writer that puts a **different photo** in a pick's slot (re-pick, repick accept, new hero) must strip `pinFocus`; a renewal of the **same photo** (fingerprint match, `photoName` rewritten in place) keeps it. This package cannot enforce that — it never sees the write — so every writer of a pick owns it.

### Two readers

| | for | on garbage | on the default `(0.5, 0.5, 1)` |
|---|---|---|---|
| `parsePinFocus(input)` | **writers** — the CC set-focus action, the promote DTO | `{ ok: false, reason }` | `{ ok: true, focus: null }` |
| `normalizePinFocus(input)` | **stored values** — folds, the cut, keys | `null` (centre) | `null` |

Both return the same canonical form: rounded, `scale` always spelled out, no other key, and `null` for the default — so a default focal is stored as **absent**, and a pick that never had a focal and one reset to the centre are the same pick. Neither throws, whatever the input: a throwing getter or a revoked Proxy is garbage too.

`parsePinFocus` **refuses** rather than repairs. `reason` is `"not_an_object"`, or the first bad field in `x` → `y` → `scale` order: not a finite number (a numeric string like `"2"` is bad, never coerced), out of range, or a read that throws. `null` / `undefined` is a valid reset (`{ ok: true, focus: null }`).

`normalizePinFocus` **clamps** into range and reads garbage as the centre, because a malformed stored focal must not cost a venue its pin. Its `null` therefore means both "default" and "garbage" — which is exactly why writers do not use it.

### The key

**`pinFocusKey(focus)`** is `""` when the focal normalizes to `null`, else `f:${x},${y},${scale}` of the normalized focal in JavaScript's shortest number spelling — `f:0.25,0.6,2`, never `0.250` or `2.00`. Equal focals give **byte-identical** keys however they were spelled. Build keys with it; never format the numbers by hand.

**When the key is empty, the API appends NOTHING** to the pin's coverVersion input or blob key and keeps its existing single-pass centre cut — so no existing pin re-keys or changes bytes. Only a non-empty key is appended (`${base}|${key}`), and only a focalled pin takes the focal cut below.

### The cut

**`pinCropRect(width, height, focus)`**, in integer pixels of the oriented source:

```js
side = max(1, floor(min(width, height) * 100 / round(scale * 100)))   // integer math
left = clamp(round(x * width  - side / 2), 0, width  - side)
top  = clamp(round(y * height - side / 2), 0, height - side)
```

The side is floored in integer hundredths, so it is exactly the largest square `scale` times which fits the short side (float division puts `535 / 1.07` at 499.99… and cuts 499; this cuts 500). The focal is normalized first, so a `null`, default or malformed focal cuts the centred square and an out-of-range one clamps. The square never leaves the image: a focal near an edge slides it flush against that edge. Fractional dimensions are floored; a `width` or `height` that is not a finite number ≥ 1 throws a `RangeError`.

### The resolution cap

`PIN_FOCUS_SCALE_MAX = 3` bounds the **data**; it does not guarantee resolution. The API's Google pin source is **400 px wide**, so a landscape 400 × 267 source at scale 3 cuts 89 px and a 400 × 133 panorama 44 px — the 96 px pin would upscale up to 2.2×.

**`pinFocusScaleCap(width, height, minSidePx)`** is the per-source cap: `floor(min(width, height) · 100 / minSidePx) / 100`, clamped to `[1, 3]`. It is **floored**, not rounded — 133 / 96 = 1.385…, and 1.39 would cut 95 px — so `pinCropRect` at the cap never cuts fewer than `minSidePx` pixels when the short side has that many.

| source | `pinFocusScaleCap(w, h, 96)` |
|---|---|
| 400 × 267 | 2.78 |
| 400 × 133 | 1.38 |
| 4032 × 3024 | 3 |
| 50 × 50 | 1 |

**The rule:** the CC slider caps at `pinFocusScaleCap(w, h, 96)`, and the API clamps the stored scale to the same cap at cut time — so a pin is never cut from fewer than 96 source pixels when the source allows it. `w` × `h` are the dimensions of the source the pin is **cut from** (oriented), not of whatever copy an editor displays.

### Fold parity — omit, never `null`

Every fold (CC `mapImagePick`, the city-scraper `venue-image-fold.js`) carries the focal the same way:

```js
const f = normalizePinFocus(p.pinFocus)
if (f) out.pinFocus = f
```

Never `pinFocus: null` on an output entry: an absent focal is **omitted**, so a seed or live entry without one is byte-identical to one written before v1.4.0.

### Who consumes it

| consumer | uses |
|---|---|
| **API** | `parsePinFocus` in the promote DTO; `normalizePinFocus` + `pinFocusScaleCap` + `pinCropRect` for the cut (auto-orient, extract, resize, mask); `pinFocusKey` appended to the pin's coverVersion input and blob key only when non-empty |
| **command-center** | `parsePinFocus` in the set-focus action; `pinFocusScaleCap` for the slider; `pinCropRect` for the 32 pt preview; `pinFocusKey` to key it; the fold rule above |
| **city-scraper** | the fold rule above — **parity** with the CC fold |

The dead-reference rule ignores `pinFocus`: a pick carrying one is the same pick to `deadPickPaths`, `pickRef` and `pictureState`.

## Consuming it

```json
{ "dependencies": { "@artfluence/venue-image-contract": "github:artfluence/venue-image-contract#v1.4.0" } }
```

No registry, no publish step. Pin a tag — an unpinned dependency reintroduces drift by the back door.

## Changing the rule

The rule is expected to **grow**, and at `v1.3.0` it did: as venue imagery moved off Google-hosted references toward other sources, "dead" broadened from "unmatched photo reference" to "asset unavailable" across several providers. At `v1.4.0` the package took on a second job beside it: the shared pin-focus math.

Growth is **additive**. `v1.3.0` added a branch, an export and a vocabulary; it changed no answer for a document that carries only the google marker, and the seven `v1.2.0` exports keep their names, kinds and meanings. A consumer bumps to gain url-dead, never to keep working. `v1.4.0` added five functions, two constants and the optional `pinFocus` field on `ImagePick` and `VenueImageLike`; every `v1.3.0` export answers exactly as before, a pick carrying a `pinFocus` included.

Extend it here, tag a new version, and bump each consumer deliberately. A consumer that has not bumped keeps the old meaning — visibly, in its `package.json`, rather than silently.

The next marker, whatever it keys on, follows the same doctrine: **its own field** (a writer that replaces its array must not be able to erase another's findings), **its own pin** through `pickRef` (so the entry self-invalidates on a re-pick and needs no cleanup job), and **its own kind** in `deadPickPathsByKind` when its repair differs.

## Repository rules

`prod` is the only long-lived branch and the default. Changes land by squash-merged pull request; only an admin can merge or bypass.
