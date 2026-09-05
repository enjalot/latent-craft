"""Temporary, authenticated full-corpus CLIP search benchmark (not a map API)."""
import os
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
import asyncio
from contextlib import asynccontextmanager
import hmac
import resource
import threading
import time
from pathlib import Path
import urllib.request

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

START = time.perf_counter()
STATE = {'stage': 'imported', 'ready': False}
SLOTS = threading.BoundedSemaphore(2)
INDEX_URL = 'https://huggingface.co/buckets/jasperai/monet-retrieval-storage/resolve/v1.2.0/clip/embedding_clip-vit-base-patch32.faiss'
INDEX_BYTES = 7483751844

def initialize():
    try:
        global torch, faiss, model, tokenizer, index
        STATE['stage'] = 'imports'
        import torch
        import faiss
        from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast
        torch.set_num_threads(2)
        STATE['imports_s'] = time.perf_counter() - START
        STATE['stage'] = 'model_download_load'
        t = time.perf_counter()
        source = 'openai/clip-vit-base-patch32'
        revision = '3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268'
        tokenizer = CLIPTokenizerFast.from_pretrained(source, revision=revision)
        model = CLIPTextModelWithProjection.from_pretrained(source, revision=revision).eval()
        STATE['model_download_load_s'] = time.perf_counter() - t
        STATE['stage'] = 'index_download'
        t = time.perf_counter()
        path = Path('/tmp/monet-pilot.faiss')
        if not path.exists() or path.stat().st_size != INDEX_BYTES:
            total = 0
            with urllib.request.urlopen(INDEX_URL, timeout=120) as response, path.with_suffix('.part').open('wb') as output:
                while block := response.read(8 * 1024 * 1024):
                    output.write(block)
                    total += len(block)
                    STATE['downloaded_bytes'] = total
            if total != INDEX_BYTES:
                raise RuntimeError('Index size mismatch')
            path.with_suffix('.part').replace(path)
        STATE['index_download_s'] = time.perf_counter() - t
        STATE['stage'] = 'index_load'
        t = time.perf_counter()
        index = faiss.read_index(str(path))
        if index.ntotal != 103816750 or index.d != 512:
            raise RuntimeError('Index metadata mismatch')
        STATE['index_load_s'] = time.perf_counter() - t
        STATE['ntotal'] = index.ntotal
        STATE['stage'] = 'warmup'
        run_query('a red sports car', 64)
        STATE.update(ready=True, stage='ready', startup_s=time.perf_counter() - START)
    except Exception as error:
        # Do not include remote URLs or token-bearing transport exception text.
        STATE.update(stage='error', error_type=type(error).__name__)

def run_query(query, nprobe):
    faiss.omp_set_num_threads(2)
    t = time.perf_counter()
    with torch.inference_mode():
        tokens = tokenizer(query, return_tensors='pt', truncation=True, max_length=77)
        vector = torch.nn.functional.normalize(model(**tokens).text_embeds, dim=-1).numpy()
    encoded = time.perf_counter()
    # Per-call parameters, not a mutable shared index.nprobe under concurrency.
    params = faiss.SearchParametersIVF(nprobe=nprobe)
    scores, ids = index.search(vector, 24, params=params)
    return {'ids': ids[0].tolist(), 'scores': scores[0].tolist(),
            'encode_ms': (encoded-t)*1000, 'ann_ms': (time.perf_counter()-encoded)*1000}

@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=initialize, daemon=True).start()
    yield

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

def authorize(key):
    expected = os.environ.get('PILOT_KEY', '')
    if not expected or not key or not hmac.compare_digest(key, expected):
        raise HTTPException(401, 'Pilot authorization required')

@app.get('/health')
def health(x_pilot_key: str | None = Header(default=None)):
    authorize(x_pilot_key)
    return {**STATE, 'elapsed_s': time.perf_counter()-START,
            'peak_rss_gib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024**2}

class Query(BaseModel):
    query: str = Field(min_length=1, max_length=400)
    nprobe: int = Field(default=64, ge=1, le=64)

@app.post('/search')
def search(body: Query, x_pilot_key: str | None = Header(default=None)):
    authorize(x_pilot_key)
    if not STATE['ready']:
        raise HTTPException(503, 'Warming up')
    start = time.perf_counter()
    if not SLOTS.acquire(timeout=10):
        raise HTTPException(429, 'Pilot busy')
    try:
        admitted = time.perf_counter()
        result = run_query(body.query, body.nprobe)
        result.update(queue_ms=(admitted-start)*1000, server_ms=(time.perf_counter()-start)*1000)
        return result
    finally:
        SLOTS.release()
