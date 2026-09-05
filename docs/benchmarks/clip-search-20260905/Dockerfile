FROM python:3.11-slim
RUN pip install --no-cache-dir torch==2.11.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir transformers==5.14.0 faiss-cpu==1.13.2 fastapi==0.135.1 uvicorn==0.41.0
RUN useradd -m -u 1000 pilot
WORKDIR /app
COPY --chown=pilot:pilot service.py /app/service.py
USER pilot
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "7860", "--no-access-log"]
