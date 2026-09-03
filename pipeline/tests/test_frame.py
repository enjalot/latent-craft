import numpy as np
import pytest

from lsvoxel.frame import compute_frame_3d, cubify, normalize_to_cube, robust_extent_3d


def test_cubify_equalizes_spans():
    # x span 10, y span 2, z span 4 -> all three should become 10
    extent = [0.0, 10.0, 0.0, 2.0, 0.0, 4.0]
    cubed = cubify(extent)
    x0, x1, y0, y1, z0, z1 = cubed
    spans = [x1 - x0, y1 - y0, z1 - z0]

    assert spans[0] == pytest.approx(10.0)
    assert spans[1] == pytest.approx(10.0)
    assert spans[2] == pytest.approx(10.0)

    # centers preserved
    assert (x0 + x1) / 2 == pytest.approx(5.0)
    assert (y0 + y1) / 2 == pytest.approx(1.0)
    assert (z0 + z1) / 2 == pytest.approx(2.0)


def test_normalize_to_cube_corners_map_to_pm1():
    extent = [-5.0, 5.0, -5.0, 5.0, -5.0, 5.0]
    corners = np.array([
        [-5.0, -5.0, -5.0],
        [5.0, 5.0, 5.0],
        [0.0, 0.0, 0.0],
    ])
    out = normalize_to_cube(corners, extent)
    np.testing.assert_allclose(out[0], [-1, -1, -1], atol=1e-10)
    np.testing.assert_allclose(out[1], [1, 1, 1], atol=1e-10)
    np.testing.assert_allclose(out[2], [0, 0, 0], atol=1e-10)


def test_normalize_to_cube_preserves_relative_ordering_per_axis():
    rng = np.random.default_rng(2)
    coords = rng.uniform(-3, 8, size=(200, 3))
    extent = [-3.0, 8.0, -3.0, 8.0, -3.0, 8.0]
    out = normalize_to_cube(coords, extent)
    for axis in range(3):
        order_in = np.argsort(coords[:, axis])
        order_out = np.argsort(out[:, axis])
        assert order_in.tolist() == order_out.tolist()


def test_normalize_to_cube_preserves_aspect_ratio_for_cubic_extent():
    # extent is cubic (span 10 on every axis) -> the per-axis scale factor
    # applied to any displacement must be identical on x, y, and z.
    extent = [-5.0, 5.0, -5.0, 5.0, -5.0, 5.0]
    p1 = np.array([[0.0, 0.0, 0.0]])
    p2 = np.array([[5.0, 3.0, -2.0]])
    out1 = normalize_to_cube(p1, extent)[0]
    out2 = normalize_to_cube(p2, extent)[0]

    delta_data = p2[0] - p1[0]
    delta_norm = out2 - out1
    scale = delta_norm / delta_data  # should be [0.2, 0.2, 0.2] == 2/span
    np.testing.assert_allclose(scale, [scale[0]] * 3, atol=1e-10)
    np.testing.assert_allclose(scale, [0.2, 0.2, 0.2], atol=1e-10)


def test_normalize_to_cube_does_not_clip_out_of_range_points():
    extent = [-1.0, 1.0, -1.0, 1.0, -1.0, 1.0]
    coords = np.array([[2.0, 0.0, 0.0], [-3.0, 0.0, 0.0]])
    out = normalize_to_cube(coords, extent)
    assert out[0, 0] == pytest.approx(2.0)  # outside [-1, 1], left un-clipped
    assert out[1, 0] == pytest.approx(-3.0)


def test_robust_extent_3d_trims_outliers():
    rng = np.random.default_rng(3)
    cluster = rng.normal(loc=0.0, scale=1.0, size=(1000, 3))
    outliers = np.array([
        [1000.0, 1000.0, 1000.0],
        [-1000.0, -1000.0, -1000.0],
    ])
    coords = np.vstack([cluster, outliers])

    extent = robust_extent_3d(coords)
    x0, x1, y0, y1, z0, z1 = extent

    # the extent should be dominated by the tight cluster, not the two
    # outlier points (which sit ~1000 units out on every axis)
    assert x1 < 50 and x0 > -50
    assert y1 < 50 and y0 > -50
    assert z1 < 50 and z0 > -50


def test_compute_frame_3d_shape_and_cubic_extent():
    rng = np.random.default_rng(4)
    coords = rng.normal(size=(500, 3))
    frame = compute_frame_3d(coords)

    assert {"extent", "method", "extent_pct", "pad_frac"}.issubset(frame.keys())
    assert frame["method"] == "robust_percentile_cubify"
    assert frame["extent_pct"] == [0.1, 99.9]
    assert frame["pad_frac"] == pytest.approx(0.02)
    assert len(frame["extent"]) == 6

    x0, x1, y0, y1, z0, z1 = frame["extent"]
    spans = [x1 - x0, y1 - y0, z1 - z0]
    assert spans[0] == pytest.approx(spans[1], rel=1e-9)
    assert spans[1] == pytest.approx(spans[2], rel=1e-9)
