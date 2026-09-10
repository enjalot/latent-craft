#!/usr/bin/env python3
"""Fill a missing local projection with a frozen profile, never retrain a head.

Research checkpoints, PCA and source columns stay read-only. Only a fresh
projection directory under latent-craft's data root may be created. GPU work
holds both research locks, checks for unrelated users, and limits allocations.
"""
import argparse
from contextlib import ExitStack
import fcntl
import json
from pathlib import Path
import subprocess
import time

import numpy as np
from build_fullcorpus_monet import PROFILES, SANDBOX, DATA_ROOT, MONET_POOL_DIR, COMPLEMENT, digest
from verify_fullcorpus_monet import load_head


def fingerprint(path):
    stat = path.stat()
    return dict(path=str(path), bytes=stat.st_size, mtime_ns=stat.st_mtime_ns)


def batches(counts, batch_size):
    if batch_size < 1 or any(n < 1 for n in counts):
        raise ValueError("Positive batch size and source lengths required")
    base = 0
    for source, count in enumerate(counts):
        for start in range(0, count, batch_size):
            stop = min(start + batch_size, count)
            yield source, start, stop, base + start
        base += count


def save(path, value):
    temporary = path.with_suffix(".partial.json")
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def projection_output(profile, dim):
    if dim not in (2, 3):
        raise ValueError("Projection dimension must be 2 or 3")
    output = (SANDBOX / profile["folders"][dim-2]).resolve()
    if not output.is_relative_to((DATA_ROOT / "projections").resolve()) or output.exists():
        raise ValueError("Only a fresh latent-craft projection directory may be written")
    return output


def project(profile_name, dim, device, batch_size=4096):
    profile = PROFILES[profile_name]
    output = projection_output(profile, dim)
    import torch
    torch.set_num_threads(2)
    paths = [MONET_POOL_DIR / profile["column"], COMPLEMENT / profile["column"]]
    inputs = [np.load(p, mmap_mode="r") for p in paths]
    counts = list(map(len, inputs))
    if counts != [19344847, 84471903]:
        raise ValueError("Wrong full-corpus source row layout")
    checkpoint = SANDBOX / profile["heads"][dim-2] / "champion-bs16k/model.pt"
    identity = dict(inputs=[fingerprint(p) for p in paths], checkpoint_sha256=digest(checkpoint),
        pca_sha256=digest(Path(profile["pca"])) if profile.get("pca") else None)
    head, config = load_head(checkpoint, identity["checkpoint_sha256"])
    if config["n_components"] != dim:
        raise ValueError("Head output dimensionality mismatch")
    width = 1536 if profile.get("pca") else config["input_dim"]
    if any(a.shape != (n, width) or a.dtype not in (np.float16, np.float32) for a, n in zip(inputs, counts)):
        raise ValueError("Source embedding representation mismatch")
    output.mkdir(parents=True, exist_ok=False)
    state = dict(state="waiting for GPU locks" if device == "cuda" else "projecting", done=0, total=sum(counts), identity=identity)
    save(output / "progress.json", state)
    try:
        with ExitStack() as locks:
            if device == "cuda":
                for path in (SANDBOX / ".gpu.lock", Path("/data/latent-basemap/.gpu_lease")):
                    lock = locks.enter_context(path.open("a"))
                    fcntl.flock(lock, fcntl.LOCK_EX)
                if subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], text=True).strip():
                    raise RuntimeError("GPU has another compute user despite acquired locks")
                torch.cuda.set_per_process_memory_fraction(0.20)
            if identity["inputs"] != [fingerprint(p) for p in paths] or identity["checkpoint_sha256"] != digest(checkpoint):
                raise ValueError("Inputs changed while waiting")
            head = head.to(device)
            mean = components = None
            if profile.get("pca"):
                if identity["pca_sha256"] != digest(Path(profile["pca"])):
                    raise ValueError("PCA changed while waiting")
                with np.load(profile["pca"]) as pca:
                    mean = torch.tensor(pca["mean"], device=device)
                    components = torch.tensor(pca["components"], device=device)
                if mean.shape != (1536,) or components.shape != (1536, config["input_dim"]):
                    raise ValueError("PCA dimensionality mismatch")
            partial = output / "coords.partial.npy"
            coords = np.lib.format.open_memmap(partial, mode="w+", dtype=np.float32, shape=(sum(counts), dim))
            started, last_save = time.monotonic(), 0
            with torch.inference_mode():
                for source, start, stop, offset in batches(counts, batch_size):
                    x = torch.from_numpy(np.array(inputs[source][start:stop], dtype=np.float32)).to(device)
                    if mean is not None:
                        x = torch.nn.functional.normalize((x - mean) @ components, dim=1)
                    y = head(x).cpu().numpy()
                    if not np.isfinite(y).all():
                        raise ValueError(f"Nonfinite projection at row {offset}")
                    coords[offset:offset+len(y)] = y
                    done = offset + len(y)
                    if done-last_save >= 1_000_000 or done == sum(counts):
                        coords.flush()
                        elapsed = time.monotonic()-started
                        state.update(state="projecting", done=done, wall_s=elapsed, rows_per_s=done/elapsed)
                        save(output / "progress.json", state)
                        print(f"[project] {done:,}/{sum(counts):,} rows; {done/elapsed:,.0f} rows/s", flush=True)
                        last_save = done
            coords.flush()
            if (identity["inputs"] != [fingerprint(p) for p in paths] or identity["checkpoint_sha256"] != digest(checkpoint)
                    or (profile.get("pca") and identity["pca_sha256"] != digest(Path(profile["pca"])))):
                raise ValueError("Inputs changed during projection")
            partial.rename(output / "coords.f32.npy")
            manifest = dict(schema="latent-craft-fullcorpus-projection-v1", status="complete", dim=dim,
                n_rows=sum(counts), n_pool=counts[0], n_complement=counts[1],
                row_layout=dict(pool=[0, counts[0]], complement=[counts[0], sum(counts)]),
                checkpoint=str(checkpoint), checkpoint_sha256=identity["checkpoint_sha256"],
                checkpoint_sha256_16=identity["checkpoint_sha256"][:16], training_rows=profile["training_rows"],
                input_dimensions=config["input_dim"], pca_model=profile.get("pca"), pca_sha256=identity["pca_sha256"],
                preprocessing="cast to float32; saved PCA then L2 normalization" if mean is not None else "normalized source column",
                source_identity=identity, finite_rows_checked=sum(counts), wall_s=time.monotonic()-started,
                peak_cuda_reserved_bytes=torch.cuda.max_memory_reserved() if device == "cuda" else 0)
            save(output / "manifest.json", manifest)
            state.update(state="complete")
            save(output / "progress.json", state)
            print(json.dumps(manifest), flush=True)
    except BaseException as error:
        state.update(state="failed", detail=str(error))
        save(output / "progress.json", state)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--dim", type=int, choices=(2, 3), required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    project(args.profile, args.dim, args.device)
