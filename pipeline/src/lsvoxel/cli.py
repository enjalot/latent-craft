from __future__ import annotations

import argparse
import sys

from .config import DATASET_SPECS, monet_dataset_id, points_table_path


def _report_written(out_path, df) -> None:
    n_with_url = int(df["image_url"].notna().sum())
    print(f"wrote {out_path} ({len(df):,} rows, {n_with_url:,} with an image_url)")


def cmd_build_points(args: argparse.Namespace) -> int:
    if args.dataset == "bl":
        from .datasets.bl import build_points_table

        out_path = points_table_path("bl")
        df = build_points_table(out_path)
        _report_written(out_path, df)
        return 0
    if args.dataset.startswith("monet-"):
        from .datasets.monet import build_points_table as build_monet_points_table

        arm = args.dataset[len("monet-") :]
        out_path = points_table_path(monet_dataset_id(arm))
        df = build_monet_points_table(arm, out_path)
        _report_written(out_path, df)
        return 0
    print(f"unknown dataset {args.dataset!r}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lsvoxel")
    sub = parser.add_subparsers(dest="command", required=True)

    p_points = sub.add_parser("build-points", help="build the row_id-indexed points table")
    p_points.add_argument("--dataset", required=True, choices=list(DATASET_SPECS))
    p_points.set_defaults(func=cmd_build_points)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
