FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libsndfile1 curl git \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch wheels first - chatterbox-tts pulls torch==2.6.0 unpinned by
# index, which would otherwise resolve to the much larger CUDA wheel for a
# service that only ever runs on CPU.
RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
# PyPI's chatterbox-tts (0.1.7) predates Nano/Turbo support (from_pretrained
# there takes no `nano` kwarg) - install straight from GitHub main instead.
RUN pip install --no-cache-dir "git+https://github.com/resemble-ai/chatterbox.git" fastapi "uvicorn[standard]" soundfile

COPY server.py /app/server.py
WORKDIR /app

ENV HF_HOME=/cache/huggingface
VOLUME ["/cache/huggingface"]

EXPOSE 8099
CMD ["python3", "server.py"]
