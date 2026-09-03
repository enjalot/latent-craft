import numpy as np

from lsvoxel.voxel import chunk_id_of, local_voxel_id, make_voxels, voxel_bins


def test_make_voxels_frozen_convention():
    """Lock the frozen 3D cell-index convention ported byte-identical from
    latent-scope's origin/feature/3d branch
    (latentscope/scripts/scope.py::make_voxels, lock-in tested there at
    commit 956d567). This must never drift or voxel<->minecraft<->city
    alignment breaks."""
    x = np.array([-1.0, 1.0, 0.0, 0.757], dtype=np.float64)
    y = np.array([-1.0, 1.0, 0.0, -0.298], dtype=np.float64)
    z = np.array([-1.0, 1.0, 0.0, 0.624], dtype=np.float64)

    v32 = make_voxels(x, y, z, 32)
    # corners and center, hand-computed:
    #   (-1,-1,-1) -> bins (0,0,0)      -> 0
    #   ( 1, 1, 1) -> bins clipped(31)  -> (31*32+31)*32+31 = 32767
    #   ( 0, 0, 0) -> bins (16,16,16)   -> (16*32+16)*32+16 = 16912
    #   (0.757,-0.298,0.624) -> (28,11,25) -> (25*32+11)*32+28 = 25980
    assert v32.tolist() == [0, 32767, 16912, 25980]

    # bounds: every index in [0, n^3)
    assert v32.min() >= 0 and v32.max() < 32 ** 3


def test_voxel_bins_matches_make_voxels():
    rng = np.random.default_rng(0)
    x = rng.uniform(-1, 1, 1000)
    y = rng.uniform(-1, 1, 1000)
    z = rng.uniform(-1, 1, 1000)
    n = 32
    vx, vy, vz = voxel_bins(x, y, z, n)
    expected = make_voxels(x, y, z, n)

    assert ((vz * n + vy) * n + vx).tolist() == expected.tolist()
    assert vx.min() >= 0 and vx.max() < n
    assert vy.min() >= 0 and vy.max() < n
    assert vz.min() >= 0 and vz.max() < n


def test_chunk_id_of_corner_and_boundary():
    num_voxels = 96
    vpc = 16
    g = num_voxels // vpc  # 6 chunks per axis

    # corner voxel (0,0,0) -> chunk 0
    assert chunk_id_of(np.array([0]), np.array([0]), np.array([0]), num_voxels, vpc)[0] == 0

    # far corner voxel (95,95,95) -> last chunk index
    last = g - 1
    expected_last_chunk = (last * g + last) * g + last
    got = chunk_id_of(np.array([95]), np.array([95]), np.array([95]), num_voxels, vpc)[0]
    assert got == expected_last_chunk

    # boundary: voxel bin 15 is still in chunk 0 on that axis, bin 16 is chunk 1
    assert chunk_id_of(np.array([15]), np.array([0]), np.array([0]), num_voxels, vpc)[0] == 0
    assert chunk_id_of(np.array([16]), np.array([0]), np.array([0]), num_voxels, vpc)[0] == 1


def test_chunk_id_of_rejects_non_divisible_grid():
    import pytest

    with pytest.raises(ValueError):
        chunk_id_of(np.array([0]), np.array([0]), np.array([0]), num_voxels=100, voxels_per_chunk=16)


def test_local_voxel_id_full_chunk_covers_0_to_4095():
    vpc = 16
    # every voxel bin coordinate within one chunk (0..15 on each axis)
    xs, ys, zs = np.meshgrid(np.arange(vpc), np.arange(vpc), np.arange(vpc), indexing="ij")
    xs, ys, zs = xs.ravel(), ys.ravel(), zs.ravel()
    local_ids = local_voxel_id(xs, ys, zs, vpc)

    assert local_ids.min() == 0
    assert local_ids.max() == vpc ** 3 - 1
    # full 0..4095 coverage, no collisions
    assert len(np.unique(local_ids)) == vpc ** 3
    assert sorted(local_ids.tolist()) == list(range(vpc ** 3))


def test_chunk_and_local_id_roundtrip_reconstructs_voxel_membership():
    """chunk_id_of + local_voxel_id together must let you reconstruct which
    chunk and which local slot any voxel bin belongs to, and distinct voxels
    in the same chunk must get distinct local_voxel_ids."""
    num_voxels = 32
    vpc = 16
    g = num_voxels // vpc

    rng = np.random.default_rng(1)
    combo = rng.integers(0, num_voxels, size=(2000, 3))
    combo = np.unique(combo, axis=0)  # dedupe so "distinct voxels" is meaningful
    vx, vy, vz = combo[:, 0], combo[:, 1], combo[:, 2]

    chunk_ids = chunk_id_of(vx, vy, vz, num_voxels, vpc)
    local_ids = local_voxel_id(vx, vy, vz, vpc)

    # reconstruct absolute voxel bins from (chunk_id, local_id) and confirm
    # they match the originals
    cz = chunk_ids // (g * g)
    cy = (chunk_ids // g) % g
    cx = chunk_ids % g

    lz = local_ids // (vpc * vpc)
    ly = (local_ids // vpc) % vpc
    lx = local_ids % vpc

    rx = cx * vpc + lx
    ry = cy * vpc + ly
    rz = cz * vpc + lz

    assert rx.tolist() == vx.tolist()
    assert ry.tolist() == vy.tolist()
    assert rz.tolist() == vz.tolist()

    # distinct voxels sharing a chunk must get distinct local_voxel_ids
    for cid in np.unique(chunk_ids):
        mask = chunk_ids == cid
        ids_in_chunk = local_ids[mask]
        assert len(np.unique(ids_in_chunk)) == mask.sum()
