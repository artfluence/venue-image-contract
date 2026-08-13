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

export function pickAtPath(review: ReviewLike, path: string): ImagePick | null
export function deadPickPaths(review: ReviewLike): Set<string>
export function pictureState(review: ReviewLike): PictureStateResult
