import os
from pathlib import Path
import modal

app = modal.App('lsv-clip-search-us-pilot-20260905')
image = (modal.Image.debian_slim(python_version='3.11')
    .pip_install('torch==2.11.0', index_url='https://download.pytorch.org/whl/cpu')
    .pip_install('transformers==5.14.0', 'faiss-cpu==1.13.2', 'fastapi==0.135.1', 'uvicorn==0.41.0')
    .env({'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'TOKENIZERS_PARALLELISM': 'false'})
    .add_local_file(Path(__file__).with_name('service.py'), '/root/service.py'))

@app.function(image=image, cpu=4, memory=32768, region='us', max_containers=1,
              scaledown_window=300, timeout=600,
              secrets=[modal.Secret.from_dict({'PILOT_KEY': os.environ['PILOT_KEY']})])
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def api():
    from service import app as service_app
    return service_app
