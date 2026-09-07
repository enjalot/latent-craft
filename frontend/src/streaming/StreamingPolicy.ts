import {
  RING_R0_CHUNKS, RING_R1_CHUNKS, RING_R2_CHUNKS,
  THUMBNAIL_SHOW_RADIUS_CHUNKS, THUMBNAIL_HIDE_RADIUS_CHUNKS,
  STREAM_MAX_CHUNKS, STREAM_MAX_BYTES, STREAM_MAX_INSTANCES,
} from "../config.ts";
import type { Manifest } from "./Manifest.ts";
import type { RingRadii } from "./priority.ts";

export interface StreamingPolicy {
  readonly radii: Readonly<RingRadii>;
  readonly showRadius: number;
  readonly hideRadius: number;
  /** Display all resident previews, including the retention band. */
  readonly showResident: boolean;
  readonly retainWarmChunks: boolean;
  readonly maxChunks: number;
  readonly maxBytes: number;
  readonly maxInstances: number;
}

export const DEFAULT_STREAMING_POLICY: StreamingPolicy = {
  radii: { r0: RING_R0_CHUNKS, r1: RING_R1_CHUNKS, r2: RING_R2_CHUNKS },
  showRadius: THUMBNAIL_SHOW_RADIUS_CHUNKS,
  hideRadius: THUMBNAIL_HIDE_RADIUS_CHUNKS,
  showResident: false,
  retainWarmChunks: false,
  maxChunks: STREAM_MAX_CHUNKS,
  maxBytes: STREAM_MAX_BYTES,
  maxInstances: STREAM_MAX_INSTANCES,
};

// BL's compact 160³ pack has 246 chunks / 14,688 occupied voxels. Its entire
// pack fits the existing conservative memory budget; permit more chunks,
// not more memory. Keep detailed cages and 128px previews on their own LODs.
export const BL_STREAMING_POLICY: StreamingPolicy = {
  ...DEFAULT_STREAMING_POLICY,
  radii: { r0: RING_R0_CHUNKS, r1: 5, r2: 6 },
  showResident: true,
  retainWarmChunks: true,
  maxChunks: 256,
};

export function streamingPolicyFor(
  profile: "bl-wide" | undefined,
  manifest: Manifest,
): StreamingPolicy {
  // Legacy BL packs have full-size atlases even for sparse chunks. The
  // measured compact-pack costs must not be applied to those releases.
  return profile === "bl-wide" && manifest.raw.streaming && manifest.compactAtlases
    ? BL_STREAMING_POLICY : DEFAULT_STREAMING_POLICY;
}
