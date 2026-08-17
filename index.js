"use strict"
/**
 * @artfluence/venue-image-contract — the SHARED answer to "which of this review's picks can no
 * longer be served?".
 *
 * WHY THIS IS A PACKAGE AND NOT A COPIED FILE. Two consumers must agree exactly:
 *   • city-scraper's image fold decides what a venue SERVES,
 *   • the Command Center's Picture Verifier decides what re-enters the REVIEW QUEUE.
 * If they disagree, a venue is broken in the app while the console calls it reviewed. A copied
 * file with a checksum only ever sees one side of that pair, so it reports drift rather than
 * preventing it; one implementation removes the failure mode.
 *
 * THE RULE. `renew-photo-names` records, per document, the picks it could not hand a fresh
 * reference to (`photoNamesUnmatched`: `{path, photoName, reason}`). Google answers those
 * references with 400 INVALID_ARGUMENT, which the API maps to 502 — they are not photos any more.
 *
 * A path counts as dead ONLY while the pick still carries the exact photoName the renewal failed
 * on. That pin is load-bearing: the Command Center does not clear `photoNamesUnmatched` when an
 * operator re-picks, so without it a stale marker would suppress a brand-new image. Pinning the
 * name makes the marker self-invalidating — no cleanup job, no cross-service coordination.
 *
 * Paths address picks by ARRAY POSITION (`primary`, `gallery.<i>`), never by the pick's `order`
 * field. `order` is the operator's display ordering and does not track array position; measured
 * against real data, using it agrees with position barely more often than chance.
 *
 * FORWARD NOTE. Venue imagery is moving off Google-hosted references toward other sources, with
 * Google demoted to a fallback. "Dead" will then broaden from "unmatched Google photoName" to
 * "asset unavailable" across several providers. That growth is the main reason this lives in one
 * place: extend it here, and every consumer inherits the new meaning on its next version bump
 * instead of drifting silently.
 */

/** @typedef {{source?: string, photoName?: string|null, url?: string|null, order?: number}} ImagePick */
/** @typedef {{path?: string, photoName?: string, reason?: string}} UnmatchedEntry */
/** @typedef {{primary?: ImagePick|null, gallery?: ImagePick[]|null, photoNamesUnmatched?: UnmatchedEntry[]|null}} ReviewLike */
/** @typedef {"google_places"|"site"|"manual"|"wikipedia"} VenueImageProvider */

/**
 * The PROVIDER vocabulary: where a venue image came from, as written into a seed file, stored on a
 * live venue document, and sent over the API wire. Frozen, and ORDER-SIGNIFICANT — consumers echo
 * this list in validation messages and enum declarations.
 *
 * NOT the ops-console SOURCE vocabulary. The Command Center's operator-facing picker says
 * "google" / "site" / "manual" / "wikipedia", and its `google` maps onto this list's
 * `google_places`; the other three are spelled the same on both sides. The two vocabularies stay
 * separate on purpose — one is what an operator clicks, the other is what a document and a wire
 * payload carry — so a consumer translating between them must map, never assume equality.
 *
 * CONSUMERS. control-center (seed validation + the explore doc), city-scraper (seed schema),
 * artfluence-API (its `VenueImageProvider` type and the promote DTO).
 *
 * WHY IT MOVED HERE. On 2026-08-17 the brussels promote died on a stray FOURTH copy of this list
 * (control-center#105): three copies had been kept in step by hand, the fourth had not, and it
 * rejected a provider the others accepted. Copies of a vocabulary drift exactly like copies of a
 * rule do, so this one lives beside the rule instead — one list, one tag, one bump per consumer.
 * @type {readonly VenueImageProvider[]}
 */
const VENUE_IMAGE_PROVIDERS = Object.freeze(["google_places", "site", "manual", "wikipedia"])

const GALLERY_PATH = /^gallery\.(\d+)$/

/**
 * The pick a `photoNamesUnmatched` path points at. `null` for a path that addresses nothing —
 * a malformed path, or an index past the end of the gallery.
 * @param {ReviewLike} review
 * @param {string} path
 * @returns {ImagePick|null}
 */
function pickAtPath(review, path) {
  if (!review || typeof path !== "string") return null
  if (path === "primary") return review.primary || null
  const m = GALLERY_PATH.exec(path)
  if (!m) return null
  const gallery = Array.isArray(review.gallery) ? review.gallery : []
  return gallery[Number(m[1])] || null
}

/**
 * The set of pick paths whose reference is dead. Empty for a review with no marker, and for one
 * whose marker has been superseded by an operator re-pick.
 * @param {ReviewLike} review
 * @returns {Set<string>}
 */
function deadPickPaths(review) {
  const dead = new Set()
  const marks = review && review.photoNamesUnmatched
  if (!Array.isArray(marks)) return dead
  for (const m of marks) {
    if (!m || typeof m.path !== "string" || !m.photoName) continue
    const pick = pickAtPath(review, m.path)
    if (pick && pick.photoName === m.photoName) dead.add(m.path)
  }
  return dead
}

/** A pick is servable when it is present and its reference is not dead. */
function isServable(pick, path, dead) {
  return !!pick && !dead.has(path)
}

/**
 * The venue's picture state, which is the SAME question the fold and the review queue ask, phrased
 * for each. The two outcomes below the healthy one are deliberately distinct because they are
 * different jobs: a `stale` venue still shows an image and needs a re-pick; a `none` venue shows
 * nothing and needs sourcing.
 *
 *   "ok"    — nothing dead. Serves the operator's picks; stays out of the queue.
 *   "stale" — something is dead but a pick survives. Serves the survivor; re-enters the queue.
 *   "none"  — every pick is dead. Serves NO image (tombstone); re-enters the queue for sourcing.
 *
 * @param {ReviewLike} review
 * @returns {{state: "ok"|"stale"|"none", dead: string[], survivingGalleryPaths: string[], primaryDead: boolean}}
 */
function pictureState(review) {
  const dead = deadPickPaths(review)
  const gallery = Array.isArray(review && review.gallery) ? review.gallery : []
  const survivingGalleryPaths = gallery
    .map((g, i) => (isServable(g, `gallery.${i}`, dead) ? `gallery.${i}` : null))
    .filter(Boolean)
  const primaryDead = dead.has("primary")
  const hasPrimary = !!(review && review.primary)
  let state = "ok"
  if (dead.size > 0) {
    // "none" only when the primary itself is gone AND nothing in the gallery survives it. A dead
    // slide beside a healthy primary is still a `stale` venue — it has an image, just a poorer one.
    state = primaryDead && hasPrimary && survivingGalleryPaths.length === 0 ? "none" : "stale"
  }
  return { state, dead: [...dead], survivingGalleryPaths, primaryDead }
}

module.exports = { deadPickPaths, pickAtPath, pictureState, VENUE_IMAGE_PROVIDERS }
