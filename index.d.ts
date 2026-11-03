/**
 * Where on a photo its map pin is cut — set per photo by ops in the Command Center (v1.4.0).
 *
 * `x`, `y` in [0, 1] are fractions of the ORIENTED image (after EXIF auto-orient — the photo as a
 * browser shows it). `scale` in [1, 3] zooms in: the pin square's side is the short side / scale;
 * absent reads as 1. The default is (0.5, 0.5, 1), the centred unzoomed square, and it is stored as
 * ABSENT — see `normalizePinFocus`.
 */
export interface PinFocus {
  x: number
  y: number
  scale?: number
}

/** A pin focal in canonical form — what `normalizePinFocus` / `parsePinFocus` return: scale always present. */
export interface NormalizedPinFocus {
  x: number
  y: number
  scale: number
}

/** Why `parsePinFocus` refused: not an object at all, or the first bad field in x → y → scale order. */
export type PinFocusParseReason = "not_an_object" | "x" | "y" | "scale"

export type PinFocusParseResult =
  | { ok: true; focus: NormalizedPinFocus | null }
  | { ok: false; reason: PinFocusParseReason }

/** A pin's square in integer pixels of the oriented source — what `pinCropRect` returns. */
export interface PinCropRect {
  left: number
  top: number
  side: number
}

export interface ImagePick {
  source?: string
  photoName?: string | null
  url?: string | null
  order?: number
  /**
   * The map-pin focal of THIS photo (v1.4.0). Absent or `null` = the centred square at scale 1.
   * It describes one photo, so it is the WRITER'S OBLIGATION to keep it with that photo: a writer
   * that puts a different photo in the slot must strip `pinFocus`; a renewal of the same photo
   * (fingerprint match) keeps it. Validate writes with `parsePinFocus`, so a default focal is
   * stored as absent.
   */
  pinFocus?: PinFocus | null
}

/** A `photoNamesUnmatched` entry — the google renewal's record of a pick it could not renew. */
export interface UnmatchedEntry {
  path?: string
  photoName?: string
  /** See `GOOGLE_UNMATCHED_REASONS`, plus the open-ended `fetch_error:<detail>`. */
  reason?: string
}

/**
 * A `urlPicksUnmatched` entry — the url-liveness detector's record of a url-keyed pick (source
 * `site` / `manual` / `wikipedia`) whose url no longer serves an image.
 *
 * `path` is the same idiom as the google marker: `primary` or `gallery.<i>`, by ARRAY POSITION.
 * `url` is REQUIRED, non-empty and PROTOCOL-SHAPED (`http://` or `https://`) — it is the pin, and an
 * entry whose url is any other shape counts for nothing. That gate is what keeps the halves apart: a
 * google pick is addressed by its photoName, so a photoName written into this field would compare
 * equal and kill a healthy google pick. `source` is a triage hint only and takes no part in the
 * match; `reason` is documentation (see `URL_DEAD_REASONS`) and is never validated.
 *
 * TO BE WRITTEN ONLY by the url-liveness detector, through a dedicated shape in the city-scraper
 * write-guard (planned — it lands with the detector). The Command Center reads it and re-picks; it
 * never writes it. Entries are self-invalidating — an entry counts only while
 * `pickRef(pickAtPath(review, path)) === url`.
 */
export interface UrlUnmatchedEntry {
  path?: string
  url?: string
  source?: string
  reason?: string
}

/** An image entry as a LIVE venue document carries it — provider-tagged, `photoName` or `url`. */
export interface VenueImageLike {
  provider?: string
  photoName?: string | null
  url?: string | null
  /** The map-pin focal the fold carried over from the pick (v1.4.0). Absent or `null` = centre. */
  pinFocus?: PinFocus | null
}

export interface ReviewLike {
  primary?: ImagePick | null
  gallery?: ImagePick[] | null
  /** Google-side dead marks. Rewritten WHOLESALE by every `renew-photo-names` run. */
  photoNamesUnmatched?: UnmatchedEntry[] | null
  /** Url-side dead marks. A separate field precisely because the renewal replaces the one above. */
  urlPicksUnmatched?: UrlUnmatchedEntry[] | null
}

/**
 * Dead paths split by WHY they are dead. A path dead both ways is in both sets; the union is
 * `deadPickPaths`. Google-dead admits an automatic repick proposal, url-dead admits only an
 * operator re-pick in the grid.
 */
export interface DeadPickPathsByKind {
  google: Set<string>
  url: Set<string>
}

/**
 * "ok"    nothing dead — serves the operator's picks, stays out of the review queue
 * "stale" something dead but a pick survives — serves the survivor, needs a re-pick
 * "none"  every pick dead — serves NO image, needs sourcing
 */
export type PictureState = "ok" | "stale" | "none"

export interface PictureStateResult {
  state: PictureState
  dead: string[]
  survivingGalleryPaths: string[]
  primaryDead: boolean
}

/**
 * The PROVIDER vocabulary — where a venue image came from, as a seed file writes it, a live venue
 * document stores it, and the API wire carries it. Frozen and order-significant.
 *
 * Distinct from the ops-console SOURCE vocabulary ("google" | "site" | "manual" | "wikipedia"),
 * whose `google` maps onto `google_places`. Consumers: control-center (seed validation + explore
 * doc), city-scraper (seed schema), artfluence-API (`VenueImageProvider` + promote DTO).
 */
export const VENUE_IMAGE_PROVIDERS: readonly ["google_places", "site", "manual", "wikipedia"]

export type VenueImageProvider = (typeof VENUE_IMAGE_PROVIDERS)[number]

/**
 * The REASON vocabulary of a `photoNamesUnmatched` entry — why the google renewal could not hand a
 * pick a fresh reference. NOT exhaustive: transport failures are minted as `fetch_error:<detail>`,
 * so match `GOOGLE_FETCH_ERROR_REASON_PREFIX` as well as this list.
 */
export const GOOGLE_UNMATCHED_REASONS: readonly [
  "ambiguous_old",
  "ambiguous_fresh",
  "no_fresh_match",
  "no_fingerprint",
  "divergent_duplicates",
  "invalid_fresh_target",
]

/** The open-ended half of the google vocabulary: `fetch_error:ETIMEDOUT`, `fetch_error:503`, … */
export const GOOGLE_FETCH_ERROR_REASON_PREFIX: "fetch_error:"

/**
 * The REASON vocabulary of a `urlPicksUnmatched` entry, as the url-liveness detector mints it.
 * Every one carries `URL_DEAD_REASON_PREFIX`, which is how a consumer routes by kind without
 * knowing either list.
 *
 * Each is a VERDICT, not a probe result. An inconclusive probe — timeout, reset, 5xx, transport
 * abort — must not be written as a mark at all, which is why there is no open-ended transport member
 * here mirroring the google side's `fetch_error:<detail>`. Inconclusive outcomes belong to the
 * detector's suspect machinery until they harden. `url_host_dead` means a persistent, NXDOMAIN-class
 * death, not a bad hour.
 *
 * DOCUMENTATION, NOT VALIDATION — nothing here checks a reason, and an entry with an unknown, empty
 * or absent one still marks its path dead. The doctrine binds the detector, and is enforced there.
 */
export const URL_DEAD_REASONS: readonly ["url_gone", "url_moved", "url_host_dead", "url_forbidden"]

/** Every url-dead reason starts with this. */
export const URL_DEAD_REASON_PREFIX: "url_"

export type GoogleUnmatchedReason = (typeof GOOGLE_UNMATCHED_REASONS)[number]
export type UrlDeadReason = (typeof URL_DEAD_REASONS)[number]

export function pickAtPath(review: ReviewLike, path: string): ImagePick | null

/**
 * Every dead pick path, from BOTH markers: google-dead (`photoNamesUnmatched`, pinned by
 * `photoName`) and url-dead (`urlPicksUnmatched`, pinned by `pickRef` === the marked url), unioned.
 *
 * A document carrying no `urlPicksUnmatched` answers exactly as it did at v1.2.0 — the google branch
 * runs first and is unchanged, membership and iteration order alike.
 */
export function deadPickPaths(review: ReviewLike): Set<string>

/**
 * The same verdict split by WHY, for triage routing: `google` admits an automatic repick proposal
 * (the photo still exists in Places), `url` does not (the asset is gone — only an operator re-pick
 * in the grid replaces it). A path dead both ways lands in both sets; the union is `deadPickPaths`.
 */
export function deadPickPathsByKind(review: ReviewLike): DeadPickPathsByKind

export function pictureState(review: ReviewLike): PictureStateResult

/**
 * The reference a REVIEW PICK is addressed by: a google pick → `photoName`, a site / manual /
 * wikipedia pick → `url`. A google pick is never addressed by a url beside it. `null` when there is
 * no usable reference.
 *
 * Reads the ops-console SOURCE vocabulary only — `google_places` is a provider, not a pick source.
 * For live venue documents use `liveImageRef`.
 */
export function pickRef(pick: ImagePick | null | undefined): string | null

/**
 * The reference a LIVE VENUE IMAGE is addressed by: `google_places` → `photoName`, site / manual /
 * wikipedia → `url`. The live-document twin of `pickRef`, and the way to build `shownRefs`:
 *
 * ```ts
 * new Set([doc.image, ...(doc.images ?? [])].map(liveImageRef).filter((r): r is string => !!r))
 * ```
 *
 * Keying a live entry as `photoName ?? url` looks equivalent and is not — it disagrees on an entry
 * carrying both.
 */
export function liveImageRef(img: VenueImageLike | null | undefined): string | null

/**
 * The dead paths a REVIEW QUEUE should still act on, given what the live venue shows.
 *
 * `shownRefs` is the set of refs the live venue currently shows, built with `liveImageRef`; a dead
 * path survives only when its pick's ref is in it. An empty set is a promoted, tombstoned venue and
 * suppresses everything. `null` / `undefined` means no live document to compare against — not
 * promoted, or not loaded — and fails OPEN, returning `deadPickPaths` unchanged. So does anything
 * that is not an iterable of non-empty string refs: a `Map`, a list of unkeyed live entries.
 *
 * QUEUE ONLY. Never feed this to the image fold or to `pictureState`: `shownRefs` is derived from
 * the fold's own output, so routing it back makes the fold's input depend on itself and re-serves a
 * dead reference. Serving reads `deadPickPaths`; queues and the promote gate read this.
 */
export function queueDeadPickPaths(
  review: ReviewLike,
  shownRefs?: Set<string> | Iterable<string> | null,
): Set<string>

/** The smallest zoom a pin focal may carry (1): the largest square the photo holds. */
export const PIN_FOCUS_SCALE_MIN: 1

/**
 * The largest zoom a pin focal may carry (3): a square one third of the photo's short side. A
 * ceiling on the data, not a resolution guarantee — see `pinFocusScaleCap`.
 */
export const PIN_FOCUS_SCALE_MAX: 3

/**
 * The LENIENT reader, for stored values (folds, the cut, keys): the canonical focal, or `null` for
 * "cut the centred square".
 *
 * x, y must be finite numbers: clamped to [0, 1], rounded to 3 dp. scale, when present and not
 * `null`, must be a finite number: clamped to [1, 3], rounded to 2 dp; absent reads as 1. Rounding is
 * `Math.round(v · 10^p) / 10^p`. The result always spells `scale` out and carries no other key.
 *
 * `null` for the DEFAULT (0.5, 0.5, 1) judged after clamping and rounding — so a default focal is
 * stored as absent and hashes to nothing — AND for garbage: `null` / `undefined`, a non-object, any
 * non-finite or non-number field, a read that throws. Writers use `parsePinFocus`, which tells the
 * two apart. Never throws.
 */
export function normalizePinFocus(input: unknown): NormalizedPinFocus | null

/**
 * The STRICT reader, for writers (the CC set-focus action, the promote DTO). `{ok: true, focus}` for
 * a valid focal — `focus` canonical, or `null` for the default and for `null` / `undefined` (a reset).
 * `{ok: false, reason}` for anything else: `"not_an_object"`, or the first bad field (`"x"`, `"y"`,
 * `"scale"`) — not a finite number (`"2"` is bad, never coerced), out of range, or a throwing read.
 * Never throws.
 */
export function parsePinFocus(input: unknown): PinFocusParseResult

/**
 * The canonical cache-key fragment: `""` when the focal normalizes to `null`, else
 * `f:${x},${y},${scale}` of the normalized focal in JavaScript's shortest number spelling
 * (`f:0.25,0.75,2`). Equal focals give byte-identical keys. The API appends it to the pin's
 * coverVersion and blob key only when non-empty; the CC keys its preview with it — never format the
 * numbers by hand.
 */
export function pinFocusKey(focus: unknown): string

/**
 * The square a pin is cut from, in integer pixels of the ORIENTED `width` × `height` source:
 * `side = max(1, floor(min(width, height) · 100 / round(scale · 100)))` (integer math),
 * `left = clamp(round(x·width − side/2), 0, width − side)`, `top` the same with y and height. The
 * focal is normalized first, so `null`, the default or garbage cuts the centred square. Fractional
 * dimensions are floored. Does not apply `pinFocusScaleCap`.
 *
 * @throws {RangeError} when `width` or `height` is not a finite number ≥ 1, or is above `MAX_SAFE_INTEGER / 100`.
 */
export function pinCropRect(width: number, height: number, focus: unknown): PinCropRect

/**
 * The largest 2 dp scale that still cuts ≥ `minSidePx` pixels from the `width` × `height` pin SOURCE:
 * `floor(min(width, height) · 100 / minSidePx) / 100`, clamped to [1, 3]. Floored, so `pinCropRect` at
 * the cap never falls below `minSidePx` when the source has that many pixels. The CC slider caps at
 * `pinFocusScaleCap(w, h, 96)`; the API clamps the stored scale to the same cap at cut time.
 *
 * @throws {RangeError} when `width` or `height` is not a finite number ≥ 1 or is above `MAX_SAFE_INTEGER / 100`, or `minSidePx` is not a
 * finite number > 0.
 */
export function pinFocusScaleCap(width: number, height: number, minSidePx: number): number
