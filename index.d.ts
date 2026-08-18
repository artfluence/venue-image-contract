export interface ImagePick {
  source?: string
  photoName?: string | null
  url?: string | null
  order?: number
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
