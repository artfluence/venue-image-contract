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

/** Google in the ops-console PICK vocabulary. Its live-document twin is `google_places`. */
const GOOGLE_PICK_SOURCE = "google"

/** Google in the live-document PROVIDER vocabulary. Its pick-side twin is `google`. */
const GOOGLE_PROVIDER = "google_places"

/** A non-empty string, or `null` — the one shape a reference is allowed to take. */
function refString(value) {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * The ref an entry is addressed by, given which of its two vocabularies names Google. Google is
 * addressed by `photoName`, everything else by `url`; a tag the caller did not record at all falls
 * back on whichever ref the entry carries, so a half-written document resolves instead of vanishing.
 */
function refOf(entry, tag, googleTag) {
  if (!entry || typeof entry !== "object") return null
  const name = typeof tag === "string" ? tag : ""
  if (name === googleTag) return refString(entry.photoName)
  if (name) return refString(entry.url)
  return refString(entry.photoName) || refString(entry.url)
}

/**
 * The reference a REVIEW PICK is addressed BY — the one string a live venue document holds for the
 * image this pick chose, so a pick and a live image can be compared without either side guessing.
 *
 *   google (the ops-console SOURCE spelling)  → `photoName`
 *   site / manual / wikipedia                 → `url`
 *
 * A google pick is NEVER addressed by a url it happens to carry: its identity is the photoName, and
 * any url beside it is a rendering of that name, which changes on every renewal. `null` when there
 * is no usable reference at all.
 *
 * This reads the PICK vocabulary only. `google_places` is the live document's spelling, not a pick
 * source, and is not quietly accepted here — the two vocabularies stay separate exactly as the
 * provider list above says they do. For the live-document side use {@link liveImageRef}.
 * @param {ImagePick|null|undefined} pick
 * @returns {string|null}
 */
function pickRef(pick) {
  return refOf(pick, pick && pick.source, GOOGLE_PICK_SOURCE)
}

/**
 * The reference a LIVE VENUE IMAGE is addressed by — `liveImageRef` is to a promoted document what
 * {@link pickRef} is to a review, and the two agree on every photo because the fold copies
 * `photoName` and `url` onto a live entry verbatim.
 *
 *   google_places (the live/wire PROVIDER spelling) → `photoName`
 *   site / manual / wikipedia                       → `url`
 *
 * This is how a caller builds the `shownRefs` that {@link queueDeadPickPaths} takes: map it over the
 * live document's `image` and `images`, drop the nulls, collect a Set. Keying a live entry as
 * `photoName ?? url` instead looks equivalent and is not — it disagrees on an entry carrying both,
 * and a ref that disagrees suppresses a queue item that should have been raised.
 * @param {{provider?: string, photoName?: string|null, url?: string|null}|null|undefined} img
 * @returns {string|null}
 */
function liveImageRef(img) {
  return refOf(img, img && img.provider, GOOGLE_PROVIDER)
}

/**
 * The dead paths a REVIEW QUEUE should still act on, given what the live venue actually shows.
 *
 * THE PROBLEM. Once a venue is promoted, its live document — not the review — decides what users
 * see. An operator's review can hold dead picks the live venue never adopted, or dropped long ago.
 * Queueing those asks an operator to re-pick an image nobody is looking at, and blocks the promote
 * gate on a defect with no user-visible symptom.
 *
 * THE RULE. `shownRefs` is the set of references the live venue currently shows, built with
 * {@link pickRef}'s vocabulary. A dead path survives only when its pick's ref is in that set. A
 * promoted venue that shows nothing (tombstoned: the live document exists, carries no image) passes
 * an EMPTY set and suppresses all of its dead picks — there is nothing on screen to repair.
 *
 * BUILDING `shownRefs`. Map {@link liveImageRef} over the live document's `image` AND `images`,
 * dropping the nulls — the hero is a field of its own, and a document whose `images` array is
 * missing or trimmed still shows it:
 *
 *     const shown = liveVenue
 *       ? new Set([liveVenue.image, ...(liveVenue.images || [])].map(liveImageRef).filter(Boolean))
 *       : null
 *
 * A ref that is not built this way is not a ref: pass anything else — a Map, a list of unkeyed live
 * entries — and this fails OPEN rather than reading it as a venue showing nothing.
 *
 * FAIL OPEN. `null` / `undefined` means "no live document to compare against" — the venue is not
 * promoted, or the caller could not load it — and every dead path is returned unchanged. Suppression
 * requires positive evidence of what is shown; absence of evidence queues the work.
 *
 * QUEUE ONLY. This MUST NEVER feed the image fold or {@link pictureState}. Both compute what a venue
 * SERVES, and `shownRefs` is derived from that same live document: routing this back into them makes
 * the fold's input depend on its own output, and a promoted venue would re-serve the very reference
 * that is dead. Folds and serving read {@link deadPickPaths}; queues and the promote gate read this.
 *
 * @param {ReviewLike} review
 * @param {Set<string>|Iterable<string>|null|undefined} shownRefs refs the LIVE venue shows; `null` when not promoted
 * @returns {Set<string>}
 */
function queueDeadPickPaths(review, shownRefs) {
  const dead = deadPickPaths(review)
  const shown = toRefSet(shownRefs)
  if (!shown) return dead
  const queued = new Set()
  for (const path of dead) {
    const ref = pickRef(pickAtPath(review, path))
    if (ref !== null && shown.has(ref)) queued.add(path)
  }
  return queued
}

/**
 * `shownRefs` as a Set of refs, or `null` for "no live document to compare against".
 *
 * `null` covers every value that is not an iterable OF REFS: not iterable at all, or iterable but
 * yielding something else — a `Map` (which yields `[key, value]` pairs, never a ref), a list of live
 * image entries someone forgot to key, a list with one stray blank. CONTENT is checked, not just
 * shape, because the failure that matters is silent: reading a container the caller filled wrongly
 * as "this venue shows nothing" suppresses its entire queue and reports nothing. Suppression is only
 * ever allowed on positive evidence of what is shown, so anything doubtful fails OPEN.
 *
 * An EMPTY iterable is not doubtful — it is a promoted, tombstoned venue, and it suppresses.
 */
function toRefSet(shownRefs) {
  if (shownRefs === null || shownRefs === undefined) return null
  if (typeof shownRefs !== "object" || typeof shownRefs[Symbol.iterator] !== "function") return null
  const refs = new Set()
  for (const ref of shownRefs) {
    if (refString(ref) === null) return null
    refs.add(ref)
  }
  return refs
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

module.exports = {
  deadPickPaths,
  liveImageRef,
  pickAtPath,
  pickRef,
  pictureState,
  queueDeadPickPaths,
  VENUE_IMAGE_PROVIDERS,
}
