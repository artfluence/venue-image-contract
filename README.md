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
  deadPickPaths, liveImageRef, pickAtPath, pickRef, pictureState, queueDeadPickPaths,
  VENUE_IMAGE_PROVIDERS,
} = require("@artfluence/venue-image-contract")

deadPickPaths(review)                  // Set<"primary" | "gallery.<i>">
pickAtPath(review, path)               // ImagePick | null
pickRef(pick)                          // string | null — the ref a review pick is addressed by
liveImageRef(img)                      // string | null — the ref a LIVE doc entry is addressed by
pictureState(review)                   // { state, dead, survivingGalleryPaths, primaryDead }
queueDeadPickPaths(review, shownRefs)  // Set<path> — the dead paths a QUEUE should still act on
VENUE_IMAGE_PROVIDERS                  // readonly ["google_places", "site", "manual", "wikipedia"]
```

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
{ "dependencies": { "@artfluence/venue-image-contract": "github:artfluence/venue-image-contract#v1.2.0" } }
```

No registry, no publish step. Pin a tag — an unpinned dependency reintroduces drift by the back door.

## Changing the rule

The rule is expected to **grow**. As venue imagery moves off Google-hosted references toward other sources, "dead" broadens from "unmatched photo reference" to "asset unavailable" across several providers.

Extend it here, tag a new version, and bump each consumer deliberately. A consumer that has not bumped keeps the old meaning — visibly, in its `package.json`, rather than silently.

## Repository rules

`prod` is the only long-lived branch and the default. Changes land by squash-merged pull request; only an admin can merge or bypass.
