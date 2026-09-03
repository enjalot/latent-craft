"""Ported by copy from ~/code/latent-basemap/experiments/mappack/map_pack.py
(commit as of 2026-09-03) — the production 2D tile/density pack builder behind
latent-basemap's `mapviewer/`. Deliberately vendored rather than imported:
map_pack.py's Substrate/text-sidecar machinery is a text-corpus-provenance
system that doesn't apply to a single flat image-points table, but the pure
numeric functions below (quantization, tiling, density pyramid, point/LOD
packing) are exactly what a 2D minimap for this project needs, byte-identical
to what `mapviewer/` already knows how to load.

Do NOT "improve" or re-derive these — if map_pack.py's formulas change, port
the change here explicitly and note it, so the byte contract stays traceable
to its source. Only change made versus the original: no text/bin-samples
functions (build_bin_samples/build_snippets) were ported, since this project
has no per-substrate text sidecar to draw from (image dataset).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# Contract constants — verbatim from map_pack.py
# --------------------------------------------------------------------------
PACK_FORMAT_VERSION = "1"
TILE_BINS = 256  # bins per tile side
QUANT_LEVELS = 65536  # u16 quantization of the full extent
MAX_ZOOM_CAP = 5  # >= ~1 bin per ~50 points; capped so 100M -> z=5
CORE_RADIUS_PCT = 99.5  # trimmed-core radius percentile
EXTENT_PCT = (0.1, 99.9)  # percentile extent of the core
PAD_FRAC = 0.02
CMAP = "YlGnBu"
CHUNK_ROWS = 2_000_000
ID_BITS = 28  # packed u32 = corpus<<28 | row_id


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def sha256_file(path: Path, block: int = 1 << 22) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(block), b""):
            h.update(chunk)
    return h.hexdigest()


def file_entry(path: Path) -> dict:
    return {"bytes": path.stat().st_size, "sha256": sha256_file(path)}


def choose_max_zoom(n: int) -> int:
    """Smallest z whose finest grid has >= n bins, capped at MAX_ZOOM_CAP."""
    z = 0
    while z < MAX_ZOOM_CAP and (TILE_BINS * (1 << z)) ** 2 < n:
        z += 1
    return z


def morton8(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Interleave the low 8 bits of x and y (x in even bit positions)."""

    def spread(v: np.ndarray) -> np.ndarray:
        v = v.astype(np.uint32) & np.uint32(0xFF)
        v = (v | (v << np.uint32(4))) & np.uint32(0x0F0F)
        v = (v | (v << np.uint32(2))) & np.uint32(0x3333)
        v = (v | (v << np.uint32(1))) & np.uint32(0x5555)
        return v

    return (spread(x) | (spread(y) << np.uint32(1))).astype(np.uint32)


def rank_within(gids: np.ndarray, priority: np.ndarray) -> np.ndarray:
    """Rank of each element inside its group, ordered by `priority`."""
    order = np.lexsort((priority, gids))
    g = gids[order]
    new = np.empty(len(g), dtype=bool)
    new[0] = True
    np.not_equal(g[1:], g[:-1], out=new[1:])
    starts = np.flatnonzero(new)
    lengths = np.diff(np.append(starts, len(g)))
    ranks_sorted = np.arange(len(g), dtype=np.int64) - np.repeat(starts, lengths)
    out = np.empty(len(g), dtype=np.int64)
    out[order] = ranks_sorted
    return out


def cap_for_budget(counts: np.ndarray, budget: int) -> int:
    """Largest per-bin cap c with sum(min(count, c)) <= budget (>= 1)."""
    total = int(counts.sum())
    if total <= budget:
        return int(counts.max()) if counts.size else 1
    lo, hi = 1, int(counts.max())
    best = 1
    while lo <= hi:
        mid = (lo + hi) // 2
        got = int(np.minimum(counts, mid).sum())
        if got <= budget:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best


# --------------------------------------------------------------------------
# frame
# --------------------------------------------------------------------------
def robust_extent(pts: np.ndarray) -> list[float]:
    lo, hi = EXTENT_PCT
    x0, x1 = np.percentile(pts[:, 0], [lo, hi])
    y0, y1 = np.percentile(pts[:, 1], [lo, hi])
    pad_x = PAD_FRAC * (x1 - x0) or 1.0
    pad_y = PAD_FRAC * (y1 - y0) or 1.0
    return [float(x0 - pad_x), float(x1 + pad_x), float(y0 - pad_y), float(y1 + pad_y)]


def squarify(extent: list[float]) -> list[float]:
    """Grow the shorter axis about its centre so bins are square in data units."""
    x0, x1, y0, y1 = extent
    w, h = x1 - x0, y1 - y0
    side = max(w, h)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return [cx - side / 2, cx + side / 2, cy - side / 2, cy + side / 2]


def compute_frame(coords: np.ndarray, sample_rows: int = 25_000_000) -> dict:
    """Trimmed-core extent, then squared — the build_kernels_page frame logic."""
    n = len(coords)
    if n > sample_rows:
        idx = np.linspace(0, n - 1, sample_rows).astype(np.int64)
        pts = np.asarray(coords[idx], dtype=np.float32)
    else:
        pts = np.asarray(coords, dtype=np.float32)
    radii = np.linalg.norm(pts - np.median(pts, axis=0), axis=1)
    core = pts[radii <= np.percentile(radii, CORE_RADIUS_PCT)]
    raw = robust_extent(core)
    return {
        "raw_extent": raw,
        "extent": squarify(raw),
        "core_radius_pct": CORE_RADIUS_PCT,
        "extent_pct": list(EXTENT_PCT),
        "pad_frac": PAD_FRAC,
        "extent_sample_rows": int(len(pts)),
        "squared": True,
    }


def quantize(coords: np.ndarray, extent: list[float]) -> tuple[np.ndarray, np.ndarray]:
    """u16 quantization of the full extent; y measured downward from y1.

    floor((v - lo) / (hi - lo) * 65536) clamped to [0, 65535] — floor (not
    round) so a bin index at any level is an exact right-shift of the stored
    value, which lets the validator re-derive tiles from the pack alone.
    """
    x0, x1, y0, y1 = extent
    n = len(coords)
    qx = np.empty(n, dtype=np.uint16)
    qy = np.empty(n, dtype=np.uint16)
    for i in range(0, n, CHUNK_ROWS):
        c = np.asarray(coords[i : i + CHUNK_ROWS], dtype=np.float64)
        fx = (c[:, 0] - x0) / (x1 - x0) * QUANT_LEVELS
        fy = (y1 - c[:, 1]) / (y1 - y0) * QUANT_LEVELS
        np.clip(np.floor(fx), 0, QUANT_LEVELS - 1, out=fx)
        np.clip(np.floor(fy), 0, QUANT_LEVELS - 1, out=fy)
        qx[i : i + len(c)] = fx.astype(np.uint16)
        qy[i : i + len(c)] = fy.astype(np.uint16)
    return qx, qy


def bins_at(q: np.ndarray, z: int) -> np.ndarray:
    """Bin index along one axis at zoom z, from the u16 quantized coordinate."""
    shift = 16 - (8 + z)
    if shift < 0:
        raise ValueError("zoom too deep for 16-bit quantization")
    return (q >> np.uint16(shift)).astype(np.int64)


# --------------------------------------------------------------------------
# density pyramid
# --------------------------------------------------------------------------
def render_png(counts: np.ndarray, out_path: Path, peak_log: float) -> None:
    """log1p counts through YlGnBu; empty bins white. counts is (y, x), y-down."""
    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import colormaps
    from matplotlib.image import imsave

    logc = np.log1p(counts.astype(np.float64))
    rgba = colormaps[CMAP](logc / (peak_log or 1.0))
    rgba[counts == 0] = [1.0, 1.0, 1.0, 1.0]
    imsave(out_path, rgba)


def build_density(out_dir: Path, qx, qy, corpus, n_corpora: int, max_zoom: int) -> dict:
    """One counting pass at the finest level, then 2x2 sums up the pyramid."""
    side = TILE_BINS * (1 << max_zoom)
    counts = np.zeros((n_corpora, side, side), dtype=np.uint32)
    ix = bins_at(qx, max_zoom)
    iy = bins_at(qy, max_zoom)
    flat = iy * side + ix
    del ix, iy
    for c in range(n_corpora):
        sel = np.flatnonzero(corpus == c)
        if sel.size == 0:
            continue
        for i in range(0, sel.size, CHUNK_ROWS):
            part = np.bincount(flat[sel[i : i + CHUNK_ROWS]], minlength=side * side)
            counts[c] += part.reshape(side, side).astype(np.uint32)
            del part
        del sel
    del flat

    levels = []
    cur = counts
    for z in range(max_zoom, -1, -1):
        lvl_dir = out_dir / "density" / f"z{z}"
        lvl_dir.mkdir(parents=True, exist_ok=True)
        combined = cur.sum(axis=0, dtype=np.uint64)
        peak_log = float(np.log1p(combined.max()))
        tiles_per_side = 1 << z
        index = {}
        planes = 0
        for ty in range(tiles_per_side):
            for tx in range(tiles_per_side):
                ys = slice(ty * TILE_BINS, (ty + 1) * TILE_BINS)
                xs = slice(tx * TILE_BINS, (tx + 1) * TILE_BINS)
                tile_total = int(combined[ys, xs].sum())
                if tile_total == 0:
                    continue
                present = []
                for c in range(n_corpora):
                    plane = np.ascontiguousarray(cur[c, ys, xs])
                    if not plane.any():
                        continue
                    (lvl_dir / f"{tx}_{ty}.{c}.u32").write_bytes(plane.tobytes())
                    present.append(c)
                    planes += 1
                render_png(np.asarray(combined[ys, xs]), lvl_dir / f"{tx}_{ty}.png", peak_log)
                index[f"{tx}_{ty}"] = {"n": tile_total, "corpora": present}
        (lvl_dir / "index.json").write_text(
            json.dumps(
                {
                    "z": z,
                    "tiles_per_side": tiles_per_side,
                    "bin_bytes": TILE_BINS * TILE_BINS * 4,
                    "png_log_peak": peak_log,
                    "tiles": index,
                },
                separators=(",", ":"),
            )
        )
        levels.append(
            {
                "z": z,
                "tiles_per_side": tiles_per_side,
                "bins_per_side": TILE_BINS * tiles_per_side,
                "tiles_written": len(index),
                "planes_written": planes,
                "png_log_peak": peak_log,
                "total_count": int(combined.sum()),
            }
        )
        if z > 0:
            half = cur.shape[1] // 2
            cur = cur.reshape(n_corpora, half, 2, half, 2).sum(axis=(2, 4), dtype=np.uint64).astype(
                np.uint32
            )
    levels.reverse()
    return {"levels": levels, "finest_counts": counts.sum(axis=0, dtype=np.uint64)}


# --------------------------------------------------------------------------
# points, tile index, LOD
# --------------------------------------------------------------------------
POINT_DTYPE = np.dtype([("x", "<u2"), ("y", "<u2"), ("packed", "<u4")])
LOD_DTYPE = np.dtype([("x", "<u2"), ("y", "<u2"), ("packed", "<u4"), ("minz", "u1")])


def sort_key(qx, qy, max_zoom: int) -> tuple[np.ndarray, np.ndarray]:
    """(tile row-major id, Morton within tile) packed into one u64 key."""
    ix, iy = bins_at(qx, max_zoom), bins_at(qy, max_zoom)
    t = 1 << max_zoom
    tile_id = (iy // TILE_BINS) * t + (ix // TILE_BINS)
    morton = morton8((ix % TILE_BINS).astype(np.uint32), (iy % TILE_BINS).astype(np.uint32))
    key = (tile_id.astype(np.uint64) << np.uint64(16)) | morton.astype(np.uint64)
    return tile_id, key


def build_points(out_dir: Path, qx, qy, packed, tile_id, key, max_zoom: int) -> dict:
    pdir = out_dir / "points"
    pdir.mkdir(parents=True, exist_ok=True)
    order = np.argsort(key, kind="stable")
    rec = np.empty(len(order), dtype=POINT_DTYPE)
    rec["x"] = qx[order]
    rec["y"] = qy[order]
    rec["packed"] = packed[order]
    rec.tofile(pdir / "xy_id.bin")
    del rec

    n_tiles = (1 << max_zoom) ** 2
    per_tile = np.bincount(tile_id, minlength=n_tiles).astype(np.uint64)
    offsets = np.zeros(n_tiles + 1, dtype="<u8")
    offsets[1:] = np.cumsum(per_tile) * POINT_DTYPE.itemsize
    offsets.tofile(pdir / "tile_index.u64")
    return {
        "record_bytes": POINT_DTYPE.itemsize,
        "n_points": int(len(order)),
        "n_tiles": n_tiles,
        "order": order,
        "tile_counts": per_tile,
    }


def build_lod(
    out_dir: Path, qx, qy, packed, tile_id, max_zoom: int, finest_counts: np.ndarray, seed: int
) -> dict:
    n = len(qx)
    budget = int(min(n // 4, 2_000_000))
    if budget < 1:
        budget = n
    rng = np.random.default_rng(seed)
    prio = rng.random(n)

    occ = {}
    cur = np.asarray(finest_counts)
    occ[max_zoom] = cur
    for z in range(max_zoom - 1, -1, -1):
        half = cur.shape[0] // 2
        cur = cur.reshape(half, 2, half, 2).sum(axis=(1, 3))
        occ[z] = cur
    strat_z = 0
    for z in range(max_zoom, -1, -1):
        if int((occ[z] > 0).sum()) <= budget:
            strat_z = z
            break
    counts_s = occ[strat_z].reshape(-1)
    cap = cap_for_budget(counts_s[counts_s > 0].astype(np.int64), budget)
    side_s = TILE_BINS << strat_z
    strat_bin = bins_at(qy, strat_z) * side_s + bins_at(qx, strat_z)
    ranks = rank_within(strat_bin, prio)
    sel = np.flatnonzero(ranks < cap)
    if sel.size > budget:
        sel = sel[np.lexsort((prio[sel], ranks[sel]))[:budget]]
        sel.sort()
    del occ, cur, ranks, strat_bin

    minz = np.full(sel.size, max_zoom, dtype=np.uint8)
    prev_cap = 0
    for z in range(0, max_zoom):
        gid = bins_at(qy[sel], z) * (TILE_BINS << z) + bins_at(qx[sel], z)
        counts_z = np.bincount(gid)
        counts_z = counts_z[counts_z > 0]
        target = max(1, budget // (4 ** (max_zoom - z)))
        cz = max(prev_cap, cap_for_budget(counts_z, target))
        prev_cap = cz
        vis = rank_within(gid, prio[sel]) < cz
        minz[vis & (minz > z)] = z

    order = np.lexsort((tile_id[sel], minz))
    rec = np.empty(sel.size, dtype=LOD_DTYPE)
    s = sel[order]
    rec["x"] = qx[s]
    rec["y"] = qy[s]
    rec["packed"] = packed[s]
    rec["minz"] = minz[order]
    rec.tofile(out_dir / "points" / "lod.bin")
    counts = np.bincount(rec["minz"], minlength=max_zoom + 1)
    starts = np.zeros(max_zoom + 2, dtype=np.int64)
    starts[1:] = np.cumsum(counts)
    return {
        "record_bytes": LOD_DTYPE.itemsize,
        "n_points": int(sel.size),
        "budget": budget,
        "stratify_zoom": int(strat_z),
        "stratify_cap": int(cap),
        "min_zoom_counts": [int(v) for v in counts],
        "min_zoom_offsets": [int(v) * LOD_DTYPE.itemsize for v in starts],
    }
