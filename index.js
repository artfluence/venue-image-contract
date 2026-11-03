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
 * THE SECOND HALF (v1.3.0). The forward note below arrived: url-keyed picks — source site, manual,
 * wikipedia — rot too. A page 404s, a CDN path moves, a host lapses. A url-liveness detector records
 * those in a marker of its own (`urlPicksUnmatched`: `{path, url, source?, reason}`), and this rule
 * now answers dead for BOTH markers. The two fields stay separate on purpose: `renew-photo-names`
 * REPLACES `photoNamesUnmatched` wholesale on every run, and folding url findings into it would have
 * the renewal silently erase the detector's work on its next pass.
 *
 * WHO WRITES WHAT. `urlPicksUnmatched` is to have exactly ONE writer: the url-liveness detector,
 * through a dedicated shape in the city-scraper write-guard (PLANNED — the shape lands with the
 * detector; this contract is the vocabulary it will be written against, and ships first so both
 * sides are built against one definition). The Command Center never writes this field — it READS it
 * (to route triage) and it re-picks, and a re-pick is what retires an entry. There is
 * no clear step and no cleanup job on either marker, because there is no need for one: an entry
 * counts only while the pick it names still carries the reference it died on, so healing the pick
 * invalidates the entry in the same write. That doctrine is the whole reason neither field needs
 * cross-service coordination — keep any new marker to it.
 *
 * FORWARD NOTE. Venue imagery is moving off Google-hosted references toward other sources, with
 * Google demoted to a fallback. "Dead" has broadened from "unmatched Google photoName" to "asset
 * unavailable" across several providers. That growth is the main reason this lives in one place:
 * extend it here, and every consumer inherits the new meaning on its next version bump instead of
 * drifting silently.
 */

/** @typedef {{x: number, y: number, scale?: number}} PinFocus */
/** @typedef {{x: number, y: number, scale: number}} NormalizedPinFocus */
/** @typedef {{source?: string, photoName?: string|null, url?: string|null, order?: number, pinFocus?: PinFocus|null}} ImagePick */
/** @typedef {{left: number, top: number, side: number}} PinCropRect */
/** @typedef {{path?: string, photoName?: string, reason?: string}} UnmatchedEntry */
/** @typedef {{path?: string, url?: string, source?: string, reason?: string}} UrlUnmatchedEntry */
/** @typedef {{primary?: ImagePick|null, gallery?: ImagePick[]|null, photoNamesUnmatched?: UnmatchedEntry[]|null, urlPicksUnmatched?: UrlUnmatchedEntry[]|null}} ReviewLike */
/** @typedef {"google_places"|"site"|"manual"|"wikipedia"} VenueImageProvider */
/** @typedef {{google: Set<string>, url: Set<string>}} DeadPickPathsByKind */

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

/**
 * The REASON vocabulary a `photoNamesUnmatched` entry is written with — why `renew-photo-names`
 * could not hand this pick a fresh reference. Order follows the renewal's own reporting.
 *
 *   ambiguous_old         several old photos fingerprint alike; which one this pick was is unknowable
 *   ambiguous_fresh       several fresh photos match the old one equally well
 *   no_fresh_match        the place still has photos, none of them this one
 *   no_fingerprint        the old reference could not be fetched to fingerprint at all
 *   divergent_duplicates  duplicate picks of one photo renewed to different fresh references
 *   invalid_fresh_target  the fresh reference the renewal computed does not itself resolve
 *
 * NOT EXHAUSTIVE — transport failures are minted as `fetch_error:<detail>` (see
 * {@link GOOGLE_FETCH_ERROR_REASON_PREFIX}), so a consumer that switches on this list alone drops
 * every one of them. Match the prefix as well as the list.
 * @type {readonly string[]}
 */
const GOOGLE_UNMATCHED_REASONS = Object.freeze([
  "ambiguous_old",
  "ambiguous_fresh",
  "no_fresh_match",
  "no_fingerprint",
  "divergent_duplicates",
  "invalid_fresh_target",
])

/** The open-ended half of the google vocabulary: `fetch_error:ETIMEDOUT`, `fetch_error:503`, … */
const GOOGLE_FETCH_ERROR_REASON_PREFIX = "fetch_error:"

/**
 * The REASON vocabulary a `urlPicksUnmatched` entry is written with — why the url-liveness detector
 * calls this pick's url dead. Every one carries the {@link URL_DEAD_REASON_PREFIX}, which is how a
 * consumer tells the two vocabularies apart on a mixed triage screen without knowing either list.
 *
 *   url_gone       the url resolves and answers 404/410 — the asset is not there any more
 *   url_moved      it redirects somewhere that is no longer this image (a homepage, a 404 page)
 *   url_host_dead  the host does not resolve or does not answer at all — a PERSISTENT,
 *                  NXDOMAIN-class death, established over time, never a bad hour
 *   url_forbidden  the host answers 401/403 — reachable, but not servable to us
 *
 * EVERY ONE OF THESE IS A VERDICT, NOT A PROBE RESULT. An INCONCLUSIVE probe — a timeout, a reset, a
 * 5xx, a transport abort — must NOT be written here at all. It is not evidence that an asset is
 * gone; it is evidence that this attempt failed, and a marker written from it takes a live image off
 * a venue because a CDN had a bad minute. That is why this list has no open-ended transport member
 * to match the google side's `fetch_error:<detail>`, and the difference is deliberate: a google
 * `fetch_error` describes a RENEWAL that could not be completed, which is a real outcome for that
 * job, while a url probe that could not be completed is simply no outcome. Inconclusive results
 * belong to the detector's own suspect machinery — repeat, corroborate, age — and reach this field
 * only once they have hardened into one of the four verdicts above.
 *
 * DOCUMENTATION, NOT VALIDATION. Nothing in this package checks a reason against either list: an
 * entry with an unknown, empty or absent reason still marks its path dead. The vocabulary exists so
 * a triage UI can phrase the defect and a detector can spell it the same way twice — a validator
 * here would only turn a new reason into a silently-ignored marker. The doctrine above is binding on
 * the DETECTOR, and is enforced there, not here.
 * @type {readonly string[]}
 */
const URL_DEAD_REASONS = Object.freeze(["url_gone", "url_moved", "url_host_dead", "url_forbidden"])

/** Every url-dead reason starts with this. The one rule a consumer needs to route by kind. */
const URL_DEAD_REASON_PREFIX = "url_"

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
 * The set of pick paths whose reference is dead, from EITHER marker — the google renewal's
 * `photoNamesUnmatched` and the url-liveness detector's `urlPicksUnmatched`, unioned. Empty for a
 * review with no marker, and for one whose markers have all been superseded by an operator re-pick.
 *
 * A document that carries no `urlPicksUnmatched` answers exactly what v1.2.0 answered, membership
 * and iteration order alike: the google branch runs first and is untouched.
 * @param {ReviewLike} review
 * @returns {Set<string>}
 */
function deadPickPaths(review) {
  return addUrlDead(review, addGoogleDead(review, new Set()))
}

/**
 * The same verdict, SPLIT BY WHY — `{google, url}` — because the two deaths have different repairs.
 * A google-dead pick can be answered automatically: its photo still exists in Places, so a repick
 * proposal can be computed and offered. A url-dead pick cannot — the asset itself is gone, and only
 * an operator picking again in the grid can replace it. A triage UI that cannot tell them apart
 * offers a proposal it can never fulfil.
 *
 * A path dead BOTH ways (a hybrid pick carrying a marked photoName AND a marked url) appears in
 * BOTH sets — each consumer must see it. The union of the two is exactly {@link deadPickPaths}.
 * @param {ReviewLike} review
 * @returns {DeadPickPathsByKind}
 */
function deadPickPathsByKind(review) {
  return { google: addGoogleDead(review, new Set()), url: addUrlDead(review, new Set()) }
}

/**
 * The GOOGLE branch, byte-for-byte the v1.2.0 rule: a path is dead while its pick still carries the
 * exact photoName the renewal failed on.
 */
function addGoogleDead(review, dead) {
  const marks = review && review.photoNamesUnmatched
  if (!Array.isArray(marks)) return dead
  for (const m of marks) {
    if (!m || typeof m.path !== "string" || !m.photoName) continue
    const pick = pickAtPath(review, m.path)
    if (pick && pick.photoName === m.photoName) dead.add(m.path)
  }
  return dead
}

/**
 * The URL branch: a path is dead while the pick at it is still ADDRESSED BY the url the detector
 * marked — `pickRef(pickAtPath(review, path)) === entry.url`, and nothing else.
 *
 * Going through {@link pickRef} rather than reading `pick.url` is what keeps the two halves from
 * overlapping: a google pick is addressed by its photoName, so the url it carries beside that name —
 * a rendering that changes on every renewal — can never pin it dead. It also makes the entry
 * self-invalidating exactly as the google one is: re-pick, and the pin stops matching.
 *
 * THE SHAPE GATE. The marked url must be protocol-shaped (`http://` or `https://`), and that is not
 * a tidiness check — it is what keeps the two halves apart. `pickRef` of a GOOGLE pick is its
 * photoName, so a marker carrying that photoName in its `url` field would compare equal, kill a
 * perfectly healthy google pick, and file it under `url`, where triage can only ask for a manual
 * re-pick. A photoName is not a url; nothing but an http(s) url may pin.
 *
 * The gate fails SAFE in the other direction too: a marker whose url has an unrecognised shape
 * leaves its pick ALIVE. A marker is a claim that a fetchable asset is gone, and a shape this rule
 * cannot recognise is not evidence of that.
 *
 * `source` on the entry is a triage hint (which vocabulary the dead pick was written with) and takes
 * no part in the match; a stale or missing tag must not resurrect a dead pick. `reason` likewise —
 * see {@link URL_DEAD_REASONS}, which is documentation and not validation.
 */
function addUrlDead(review, dead) {
  const marks = review && review.urlPicksUnmatched
  if (!Array.isArray(marks)) return dead
  for (const m of marks) {
    if (!m || typeof m.path !== "string") continue
    const url = protocolUrl(m.url)
    if (url === null) continue
    if (pickRef(pickAtPath(review, m.path)) === url) dead.add(m.path)
  }
  return dead
}

/** The schemes a url-dead marker may pin with. A pin is a claim about a FETCHABLE asset. */
const URL_MARK_SCHEMES = Object.freeze(["http://", "https://"])

/** A url-shaped, non-empty string, or `null` — the one shape a url-dead pin is allowed to take. */
function protocolUrl(value) {
  const url = refString(value)
  if (url === null) return null
  return URL_MARK_SCHEMES.some((scheme) => url.startsWith(scheme)) ? url : null
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

// ————————————————————————— pin focus (v1.4.0) —————————————————————————
//
// WHY THIS LIVES HERE. A venue's map pin is a circle cut from its cover photo, and ops choose WHERE
// on the photo it is cut — a per-photo focal point set in the Command Center and carried on the
// approved pick (`ImagePick.pinFocus`) through the seed into the live venue image. Three places
// must agree on that cut to the pixel and on its key to the byte:
//   • the API cuts the pin and hashes the focal into the pin's coverVersion (a changed key re-cuts
//     the pin and every device refetches it; a spurious change does that for nothing),
//   • the Command Center previews the same square in its focal editor,
//   • the city-scraper fold carries the focal into the seed exactly as the CC fold does.
// Copies of a rule drift, and a drifted crop is a pin that does not show what ops chose — so the
// math lives here, once.
//
// TWO READERS OF ONE SHAPE. `parsePinFocus` is for WRITERS (the CC action, the promote DTO): it
// refuses a malformed or out-of-range focal and says which field. `normalizePinFocus` is for STORED
// values (folds, the cut, keys): it never refuses, it clamps, and garbage reads as the centre —
// a malformed stored focal must not cost a venue its pin.

/** The smallest zoom a pin focal may carry: the largest square the photo holds. */
const PIN_FOCUS_SCALE_MIN = 1

/**
 * The largest zoom a pin focal may carry: a square one third of the photo's short side. This is a
 * ceiling on the DATA, not a resolution guarantee — on a 400 × 267 source scale 3 cuts 89 px, below
 * the 96 px pin. {@link pinFocusScaleCap} is the per-source cap that keeps the cut ≥ the pin.
 */
const PIN_FOCUS_SCALE_MAX = 3

/** The focal every pick without one is cut at — the centred square, unzoomed. */
const PIN_FOCUS_CENTRE = Object.freeze({ x: 0.5, y: 0.5, scale: PIN_FOCUS_SCALE_MIN })

/** Decimal places kept on x and y (≈ 0.4 px on a 400 px source) and on scale. */
const PIN_FOCUS_XY_PLACES = 3
const PIN_FOCUS_SCALE_PLACES = 2

/** Scale is kept to 2 dp, so in hundredths it is an exact integer — the unit the side is floored in. */
const SCALE_HUNDREDTHS = 10 ** PIN_FOCUS_SCALE_PLACES

/** `parsePinFocus`'s reason when the input is not a plain object at all. */
const NOT_AN_OBJECT = "not_an_object"

/** A number that can be measured with: not NaN, not ±Infinity, not a numeric string. */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Half-up rounding to `places` decimals: `Math.round(v · 10^p) / 10^p`, never `toFixed` (which
 * returns a string and rounds the binary value, not the decimal one). Inputs here are already
 * clamped ≥ 0, so no `-0` escapes.
 */
function roundTo(value, places) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** A pixel dimension ≥ 1, floored — or a RangeError. The message never coerces (a Symbol must not TypeError). */
function pixelDimension(value, fn, name) {
  if (!isFiniteNumber(value) || value < 1) {
    throw new RangeError(`${fn}: ${name} must be a finite number ≥ 1, got ${String(value)}`)
  }
  return Math.floor(value)
}

/**
 * The raw fields of a focal, type-checked but NOT range-checked: `{ok: true, fields}` (`fields` null
 * for `null` / `undefined`) or `{ok: false, reason}` naming the first bad field. Every read is
 * guarded — a throwing getter or a revoked Proxy is a bad field, never an escaping exception.
 */
function readPinFocusFields(input) {
  if (input === null || input === undefined) return { ok: true, fields: null }
  let field = NOT_AN_OBJECT
  try {
    if (typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: NOT_AN_OBJECT }
    field = "x"
    const x = input.x
    if (!isFiniteNumber(x)) return { ok: false, reason: field }
    field = "y"
    const y = input.y
    if (!isFiniteNumber(y)) return { ok: false, reason: field }
    field = "scale"
    const scale = input.scale === undefined || input.scale === null ? PIN_FOCUS_SCALE_MIN : input.scale
    if (!isFiniteNumber(scale)) return { ok: false, reason: field }
    return { ok: true, fields: { x, y, scale } }
  } catch {
    return { ok: false, reason: field }
  }
}

/** In-range fields → the canonical focal, or `null` when that is the default (judged after rounding). */
function canonicalPinFocus({ x, y, scale }) {
  const focus = {
    x: roundTo(x, PIN_FOCUS_XY_PLACES),
    y: roundTo(y, PIN_FOCUS_XY_PLACES),
    scale: roundTo(scale, PIN_FOCUS_SCALE_PLACES),
  }
  const isCentre =
    focus.x === PIN_FOCUS_CENTRE.x && focus.y === PIN_FOCUS_CENTRE.y && focus.scale === PIN_FOCUS_CENTRE.scale
  return isCentre ? null : focus
}

/**
 * The canonical form of a STORED pin focal, or `null` for "cut the centred square" — the lenient
 * reader for folds, the cut and keys. Writers use {@link parsePinFocus}.
 *
 *   x, y   finite numbers, clamped to [0, 1], rounded to 3 dp — fractions of the ORIENTED image
 *          (after EXIF auto-orient: the photo as a browser shows it, which is what ops click on)
 *   scale  finite number, clamped to [1, 3], rounded to 2 dp; absent or `null` reads as 1
 *
 * The result always spells `scale` out and carries no other key.
 *
 * `null` for:
 *   • the DEFAULT (0.5, 0.5, 1), judged AFTER clamping and rounding — so a default focal is stored as
 *     absent, adds nothing to the pin's version, and a slider that lands a hair off centre is the
 *     centre. A pick that never had a focal and one reset to the centre are the same pick.
 *   • `null` / `undefined`, a non-object, an object whose x or y (or a present scale) is not a finite
 *     number, or one whose reads throw. Garbage is the centre, never an error.
 *
 * `null` therefore means BOTH "default" and "garbage" here — the lenient form cannot tell them apart,
 * which is exactly why writers validate with {@link parsePinFocus} instead.
 *
 * Never throws.
 * @param {unknown} input
 * @returns {NormalizedPinFocus|null}
 */
function normalizePinFocus(input) {
  const read = readPinFocusFields(input)
  if (!read.ok || !read.fields) return null
  const { x, y, scale } = read.fields
  return canonicalPinFocus({
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    scale: clamp(scale, PIN_FOCUS_SCALE_MIN, PIN_FOCUS_SCALE_MAX),
  })
}

/**
 * The STRICT reader, for writers — the CC set-focus action and the promote DTO. Same canonical form
 * as {@link normalizePinFocus}, but it REFUSES instead of repairing:
 *
 *   `{ok: true, focus}`    a valid focal; `focus` is the canonical focal, or `null` for the default
 *                          and for `null` / `undefined` (a reset is a valid write)
 *   `{ok: false, reason}`  `"not_an_object"`, or the FIRST bad field — `"x"`, `"y"`, `"scale"` — in
 *                          that order: not a finite number (a numeric string like `"2"` is bad, never
 *                          coerced), out of range (x, y outside [0, 1], scale outside [1, 3]), or a
 *                          read that throws
 *
 * Never throws.
 * @param {unknown} input
 * @returns {{ok: true, focus: NormalizedPinFocus|null} | {ok: false, reason: "not_an_object"|"x"|"y"|"scale"}}
 */
function parsePinFocus(input) {
  const read = readPinFocusFields(input)
  if (!read.ok) return read
  if (!read.fields) return { ok: true, focus: null }
  const { x, y, scale } = read.fields
  if (x < 0 || x > 1) return { ok: false, reason: "x" }
  if (y < 0 || y > 1) return { ok: false, reason: "y" }
  if (scale < PIN_FOCUS_SCALE_MIN || scale > PIN_FOCUS_SCALE_MAX) return { ok: false, reason: "scale" }
  return { ok: true, focus: canonicalPinFocus(read.fields) }
}

/**
 * The canonical cache-key fragment of a pin focal: `""` when it normalizes to `null` (absent, the
 * default, or garbage), else `f:${x},${y},${scale}` of the NORMALIZED focal, numbers in JavaScript's
 * shortest round-trip spelling — `f:0.25,0.75,2`, `f:0.3,0.5,1`, never `0.300` or `2.00`.
 *
 * The API appends it to the pin's coverVersion input and blob key ONLY when it is non-empty; the CC
 * keys its preview with it. Equal focals give BYTE-IDENTICAL keys however they were spelled, and a
 * pick without a focal keys to nothing, so every pin cut before focals existed keeps its version.
 * Build keys with this, never by formatting the numbers yourself.
 * @param {unknown} focus
 * @returns {string}
 */
function pinFocusKey(focus) {
  const f = normalizePinFocus(focus)
  return f ? `f:${f.x},${f.y},${f.scale}` : ""
}

/** Where a square of `side` starts on one axis so it centres on `at` (0..1), kept inside `length`. */
function cropOffset(at, length, side) {
  return clamp(Math.round(at * length - side / 2), 0, length - side)
}

/**
 * The square a pin is cut from, in integer pixels of the ORIENTED source (`width` × `height` after
 * EXIF auto-orient — the same space the focal was set in).
 *
 *   side = max(1, floor(min(width, height) · 100 / round(scale · 100)))
 *   left = clamp(round(x·width − side/2), 0, width − side)
 *   top  = clamp(round(y·height − side/2), 0, height − side)
 *
 * The side is floored in INTEGER hundredths, so it is exactly the largest square `scale` times which
 * fits the short side — float division would put 535 / 1.07 at 499.99… and cut 499.
 *
 * The focal goes through {@link normalizePinFocus} first, so an out-of-range focal clamps and a
 * `null`, default or malformed one cuts the CENTRED square. The square never leaves the image: a
 * focal near an edge slides it flush against that edge rather than off it. It does NOT apply
 * {@link pinFocusScaleCap} — the caller clamps the scale to the cap first when it wants one.
 *
 * Fractional dimensions are floored. A `width` or `height` that is not a finite number ≥ 1 throws a
 * RangeError — there is no square to cut, and the caller has measured the wrong thing.
 * @param {number} width
 * @param {number} height
 * @param {unknown} focus
 * @returns {PinCropRect}
 */
function pinCropRect(width, height, focus) {
  const w = pixelDimension(width, "pinCropRect", "width")
  const h = pixelDimension(height, "pinCropRect", "height")
  const f = normalizePinFocus(focus) || PIN_FOCUS_CENTRE
  const scaleHundredths = Math.round(f.scale * SCALE_HUNDREDTHS)
  const side = Math.max(1, Math.floor((Math.min(w, h) * SCALE_HUNDREDTHS) / scaleHundredths))
  return { left: cropOffset(f.x, w, side), top: cropOffset(f.y, h, side), side }
}

/**
 * The largest scale, on the 2 dp grid, that still cuts at least `minSidePx` pixels from a
 * `width` × `height` source: floor(min(width, height) · 100 / minSidePx) / 100, clamped to [1, 3].
 *
 * FLOORED, not rounded: 133 / 96 = 1.385…, and 1.39 would cut floor(133 / 1.39) = 95 px. With the
 * floor, {@link pinCropRect} at the cap cuts ≥ `minSidePx` whenever the short side has that many
 * pixels; a smaller source caps at 1, its whole short side.
 *
 * `width` × `height` are the dimensions of the source the PIN IS CUT FROM (oriented), not of
 * whatever copy an editor displays. The CC slider caps at `pinFocusScaleCap(w, h, 96)`, and the API
 * clamps the stored scale to the same cap at cut time.
 *
 * Throws a RangeError for a `width` or `height` that is not a finite number ≥ 1, or a `minSidePx`
 * that is not a finite number > 0.
 * @param {number} width
 * @param {number} height
 * @param {number} minSidePx
 * @returns {number}
 */
function pinFocusScaleCap(width, height, minSidePx) {
  const w = pixelDimension(width, "pinFocusScaleCap", "width")
  const h = pixelDimension(height, "pinFocusScaleCap", "height")
  if (!isFiniteNumber(minSidePx) || minSidePx <= 0) {
    throw new RangeError(`pinFocusScaleCap: minSidePx must be a finite number > 0, got ${String(minSidePx)}`)
  }
  const capHundredths = Math.floor((Math.min(w, h) * SCALE_HUNDREDTHS) / minSidePx)
  return clamp(capHundredths / SCALE_HUNDREDTHS, PIN_FOCUS_SCALE_MIN, PIN_FOCUS_SCALE_MAX)
}

module.exports = {
  deadPickPaths,
  deadPickPathsByKind,
  liveImageRef,
  pickAtPath,
  pickRef,
  pictureState,
  queueDeadPickPaths,
  VENUE_IMAGE_PROVIDERS,
  GOOGLE_UNMATCHED_REASONS,
  GOOGLE_FETCH_ERROR_REASON_PREFIX,
  URL_DEAD_REASONS,
  URL_DEAD_REASON_PREFIX,
  normalizePinFocus,
  parsePinFocus,
  pinFocusKey,
  pinCropRect,
  pinFocusScaleCap,
  PIN_FOCUS_SCALE_MIN,
  PIN_FOCUS_SCALE_MAX,
}
