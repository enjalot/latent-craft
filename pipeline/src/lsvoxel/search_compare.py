"""Local CLIP text projection versus exact image retrieval, on one verified map.

Inference only. Never retrains heads or changes research/published artifacts.
The optional FAISS index is built lazily in RAM, not on the projection path.
"""
from __future__ import annotations

from collections import OrderedDict
import importlib.util
import hashlib
import json
from pathlib import Path
import threading
import time

import numpy as np

DATASET = "monet-clip-basemap-training-512"
RELEASE = "monet-clip-basemap-training-20260905a"
MODEL_REVISION = "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"


def normalize_projection(point, extent):
    """Use the published frame, never fit a frame to a single query or clamp it."""
    point = np.asarray(point, dtype=np.float64)
    bounds = np.asarray(extent, dtype=np.float64).reshape(-1, 2)
    if point.shape != (len(bounds),) or not np.isfinite(point).all() or not np.isfinite(bounds).all() or np.any(bounds[:, 1] <= bounds[:, 0]):
        raise ValueError("Invalid projection/frame")
    return (2 * (point - bounds[:, 0]) / (bounds[:, 1] - bounds[:, 0]) - 1).tolist()


def validate_query(body):
    if not isinstance(body, dict) or body.get("dataset") != DATASET or body.get("release") != RELEASE:
        raise ValueError("This prototype supports only the published 2.01M basemap training release")
    query = body.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 400:
        raise ValueError("Enter between 1 and 400 characters")
    if body.get("mode") not in ("project", "search"):
        raise ValueError("Mode must be project or search")
    return query.strip(), body["mode"]


class CompareService:
    def __init__(self, data_root: Path, research_root: Path, basemap_repo: Path, training_root: Path, pool_root: Path, model_cache: Path):
        import torch
        from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast

        self.torch = torch
        torch.set_num_threads(2)
        self.index = None
        self.index_state = "not_loaded"
        self.index_rows = 0
        self.index_error = None
        self.index_lock = threading.Lock()
        self.encode_lock = threading.Lock()
        self.cache = OrderedDict()
        self.pack = data_root / "chunks" / f"{RELEASE}-512-stream"
        self.manifest = json.loads((self.pack / "manifest.json").read_text())
        if self.manifest["dataset_id"] != RELEASE or self.manifest["world"]["num_voxels"] != 512 or self.manifest["world"]["voxels_per_chunk"] != 16:
            raise ValueError("Map release mismatch")
        self.n = self.manifest["point_source"]["n_points"]
        self.vectors_path = training_root / "clip-substrate.f32.npy"
        self.vectors_shape = np.load(self.vectors_path, mmap_mode="r").shape
        if self.vectors_shape != (self.n, 512):
            raise ValueError("Training embedding shape mismatch")
        self.point_records = np.memmap(self.pack / "point_index.bin", mode="r", dtype=np.dtype([
            ("subset", "u1"), ("reserved", "u1"), ("thumb", "<u4"), ("reserved2", "<u2")]))
        self.voxel_records = np.memmap(self.pack / "row_to_voxel.bin", mode="r", dtype=np.dtype([
            ("chunk", "<u4"), ("local", "<u2"), ("reserved", "<u2")]))
        if len(self.point_records) != self.n or len(self.voxel_records) != self.n:
            raise ValueError("Map lookup length mismatch")
        self._verify_rows(training_root, pool_root)

        # Load the research project's actual architecture, without its training
        # runtime/graph dependencies. Checkpoint loading is weights-only.
        path = basemap_repo / "basemap/pumap/parametric_umap/models/mlp.py"
        spec = importlib.util.spec_from_file_location("lsv_projection_architecture", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.heads = []
        self.head_bytes = 0
        self.coords = []
        provenance = json.loads((data_root / "points" / RELEASE / "provenance.json").read_text())
        for dim, suffix in [(2, ""), (3, "-3d")]:
            folder = research_root / f"monet-random-clip-2m{suffix}" / "champion-bs16k"
            checkpoint = torch.load(folder / "model.pt", map_location="cpu", weights_only=True)
            if checkpoint["architecture"] != "residual_bottleneck" or checkpoint["input_dim"] != 512 or checkpoint["n_components"] != dim:
                raise ValueError("Unexpected projection architecture")
            head = module.ResidualBottleneckMLP(512, checkpoint["hidden_dim"], dim,
                checkpoint["n_layers"], checkpoint["neck_fraction"])
            head.load_state_dict(checkpoint["model_state_dict"], strict=True)
            self.heads.append(head.eval())
            self.head_bytes += sum(p.numel() * p.element_size() for p in head.parameters())
            coordinates = np.load(folder / "coordinates.npy", mmap_mode="r")
            with (folder / "coordinates.npy").open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != provenance["coordinates"][dim-2]["sha256"]:
                raise ValueError("Research coordinates differ from the published map release")
            if coordinates.shape != (self.n, dim):
                raise ValueError("Projection coordinate shape mismatch")
            self.coords.append(coordinates)
        self.minimap_frame = json.loads((data_root / "minimap" / RELEASE / "manifest.json").read_text())["frame"]["extent"]
        samples = np.linspace(0, self.n-1, 64, dtype=int)
        vectors = np.load(self.vectors_path, mmap_mode="r")
        with torch.inference_mode():
            self.projection_check_error = max(float(np.abs(head(torch.from_numpy(vectors[samples])).numpy() - coords[samples]).max())
                for head, coords in zip(self.heads, self.coords))
        if not np.isfinite(self.projection_check_error) or self.projection_check_error > 1e-3:
            raise ValueError("Heads do not reproduce the displayed map")

        self.tokenizer = CLIPTokenizerFast.from_pretrained(model_cache, local_files_only=True)
        self.encoder = CLIPTextModelWithProjection.from_pretrained(model_cache, local_files_only=True).eval()
        self.encoder_bytes = sum(p.numel() * p.element_size() for p in self.encoder.parameters())
        self.embed("a photograph")

    def _verify_rows(self, training_root, pool_root):
        """Verify every map row's packed source identity in substrate shard order."""
        training = json.loads((training_root / "manifest.json").read_text())
        paths = json.loads((pool_root / "manifest.json").read_text())["shards"]
        shard_ids = {path: i for i, path in enumerate(paths)}
        offset = 0
        for shard in training["shards"]:
            count = shard["rows"]
            expected = np.arange(count, dtype=np.uint32) + (shard_ids[shard["path"]] << 16)
            if not np.array_equal(self.point_records["thumb"][offset:offset+count], expected):
                raise ValueError("Training/map source row identity mismatch")
            offset += count
        if offset != self.n or training["n_rows"] != self.n:
            raise ValueError("Training provenance row count mismatch")

    def embed(self, query):
        start = time.perf_counter()
        with self.encode_lock:
            cached = self.cache.get(query)
            if cached is not None:
                self.cache.move_to_end(query)
                return cached[0], cached[1], True, (time.perf_counter()-start)*1000
            tokens = self.tokenizer(query, return_tensors="pt", truncation=False)
            truncated = tokens["input_ids"].shape[1] > 77
            if truncated:
                tokens = self.tokenizer(query, return_tensors="pt", truncation=True, max_length=77)
            with self.torch.inference_mode():
                vector = self.torch.nn.functional.normalize(self.encoder(**tokens).text_embeds, dim=-1).numpy()
            self.cache[query] = (vector, truncated)
            if len(self.cache) > 32:
                self.cache.popitem(last=False)
            return vector, truncated, False, (time.perf_counter()-start)*1000

    def prepare_index(self):
        with self.index_lock:
            if self.index_state != "not_loaded":
                return
            self.index_state = "loading"
            threading.Thread(target=self._build_index, daemon=True).start()

    def _build_index(self):
        try:
            import faiss
            faiss.omp_set_num_threads(2)
            index = faiss.IndexFlatIP(512)
            vectors = np.load(self.vectors_path, mmap_mode="r")
            for start in range(0, self.n, 32768):
                block = np.array(vectors[start:start+32768], dtype=np.float32, copy=True)
                norms = np.linalg.norm(block, axis=1, keepdims=True)
                if not np.isfinite(block).all() or np.any(norms < 1e-8):
                    raise ValueError("Invalid source embedding")
                block /= norms
                index.add(block)
                self.index_rows = index.ntotal
            self.index = index
            self.index_state = "ready"
        except Exception as error:
            self.index_error = str(error)
            self.index_state = "error"

    def status(self):
        return {"dataset": DATASET, "release": RELEASE, "rows": self.n,
            "embedding_model": "openai/clip-vit-base-patch32", "embedding_revision": MODEL_REVISION,
            "index_state": self.index_state, "index_rows": self.index_rows,
            "index_error": self.index_error, "index_bytes": self.n*512*4 if self.index is not None else 0,
            "encoder_weight_bytes": self.encoder_bytes, "projection_weight_bytes": self.head_bytes,
            "projection_check_max_error": self.projection_check_error}

    def query(self, query, mode):
        if mode == "search" and self.index_state != "ready":
            self.prepare_index()
            return None
        start = time.perf_counter()
        vector, truncated, cached, embed_ms = self.embed(query)
        t = time.perf_counter()
        with self.torch.inference_mode():
            raw2, raw3 = [head(self.torch.from_numpy(vector)).numpy()[0] for head in self.heads]
        projection_ms = (time.perf_counter()-t)*1000
        position = normalize_projection(raw3, self.manifest["world"]["frame"]["extent"])
        projection = {"position": position, "raw2": raw2.tolist(),
            "outside_frame": any(abs(p) > 1 for p in position)}
        results = []
        search_ms = 0
        if mode == "search":
            import faiss
            faiss.omp_set_num_threads(2)
            t = time.perf_counter()
            scores, ids = self.index.search(vector, 24)
            search_ms = (time.perf_counter()-t)*1000
            for row, score in zip(ids[0], scores[0]):
                if row < 0 or row >= self.n:
                    raise ValueError("Search returned an invalid row")
                voxel = self.voxel_records[row]
                results.append({"row": int(row), "score": float(score),
                    "chunk": int(voxel["chunk"]), "local": int(voxel["local"]),
                    "thumb": int(self.point_records[row]["thumb"])})
        return {"dataset": DATASET, "release": RELEASE, "query": query, "mode": mode,
            "projection": projection, "results": results, "truncated": truncated,
            "embedding_cached": cached, "timings": {"embed_ms": embed_ms,
                "project_ms": projection_ms, "search_ms": search_ms, "total_ms": (time.perf_counter()-start)*1000},
            "resources": self.status()}
