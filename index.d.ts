export interface ImagePick {
  source?: string
  photoName?: string | null
  url?: string | null
  order?: number
}

export interface UnmatchedEntry {
  path?: string
  photoName?: string
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
  photoNamesUnmatched?: UnmatchedEntry[] | null
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

export function pickAtPath(review: ReviewLike, path: string): ImagePick | null
export function deadPickPaths(review: ReviewLike): Set<string>
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
