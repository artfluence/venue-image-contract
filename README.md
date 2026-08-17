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
const { deadPickPaths, pickAtPath, pictureState, VENUE_IMAGE_PROVIDERS } = require("@artfluence/venue-image-contract")

deadPickPaths(review)    // Set<"primary" | "gallery.<i>">
pickAtPath(review, path) // ImagePick | null
pictureState(review)     // { state, dead, survivingGalleryPaths, primaryDead }
VENUE_IMAGE_PROVIDERS    // readonly ["google_places", "site", "manual", "wikipedia"]
```

`pictureState` returns the same question phrased for each consumer:

| state | serves | review queue |
|---|---|---|
| `ok` | the operator's picks | out |
| `stale` | the surviving pick | **in** — needs a re-pick |
| `none` | nothing | **in** — needs sourcing |

`stale` and `none` are deliberately distinct: they are different jobs. A `stale` venue still shows an image; a `none` venue shows nothing and needs a source found.

## Consuming it

```json
{ "dependencies": { "@artfluence/venue-image-contract": "github:artfluence/venue-image-contract#v1.1.0" } }
```

No registry, no publish step. Pin a tag — an unpinned dependency reintroduces drift by the back door.

## Changing the rule

The rule is expected to **grow**. As venue imagery moves off Google-hosted references toward other sources, "dead" broadens from "unmatched photo reference" to "asset unavailable" across several providers.

Extend it here, tag a new version, and bump each consumer deliberately. A consumer that has not bumped keeps the old meaning — visibly, in its `package.json`, rather than silently.

## Repository rules

`prod` is the only long-lived branch and the default. Changes land by squash-merged pull request; only an admin can merge or bypass.
