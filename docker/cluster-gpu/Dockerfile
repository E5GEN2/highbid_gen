# GPU-accelerated cluster runner for the niche tree.
#
# Built once via GHA on changes to docker/cluster-gpu/** or
# scripts/cluster-niches.py and pushed to ghcr.io/e5gen2/highbid-cluster.
# Designed to run as a RunPod Serverless worker — see handler.py for
# the entrypoint contract.
#
# Base: RAPIDS' minimal image. Includes Python 3.11 + cuML + cuDF +
# cuPy preinstalled, so we only layer the tiny bits the handler needs
# (psycopg2, scikit-learn for the TF-IDF labeling step, runpod-sdk).
# Image weighs in around ~6 GB which is acceptable for cold start
# given RunPod caches the layer pull per worker.

FROM rapidsai/base:24.10-cuda12.5-py3.11

# rapidsai/base ships with an unprivileged 'rapids' user; we install
# system packages as root then drop back. /app is the conventional
# working dir for RunPod handlers.
USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends libpq-dev gcc \
  && rm -rf /var/lib/apt/lists/*

# Install the handler-side deps. cuML + numpy come from the base.
# scikit-learn powers cluster-niches.py's TF-IDF auto-labeling step.
RUN pip install --no-cache-dir \
    psycopg2-binary==2.9.9 \
    runpod==1.7.0 \
    scikit-learn==1.5.2

# rapidsai's base doesn't ship umap-learn / hdbscan, which is fine —
# the use_gpu=True path skips those imports entirely. If someone ever
# triggers the CPU path inside this container, importing umap/hdbscan
# will ModuleNotFoundError loudly, which is the right failure mode.

WORKDIR /app
COPY scripts/cluster-niches.py /app/cluster-niches.py
COPY docker/cluster-gpu/handler.py /app/handler.py

# RunPod runs the worker as root by default in serverless mode, but
# being explicit doesn't hurt and matches their template images.
USER root

CMD ["python3", "-u", "/app/handler.py"]
