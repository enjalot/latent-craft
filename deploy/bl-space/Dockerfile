FROM python:3.12-slim
RUN useradd -m -u 1000 user
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir lancedb==0.37.1 faiss-cpu==1.13.2 transformers==5.14.0 fastapi==0.135.1 uvicorn==0.41.0 numpy==2.4.3
WORKDIR /app
COPY --chown=user:user . /app
USER user
ENV HOME=/home/user OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 RAYON_NUM_THREADS=2 LANCE_CPU_THREADS=2 TOKENIZERS_PARALLELISM=false
EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1", "--limit-concurrency", "48", "--timeout-keep-alive", "5"]
