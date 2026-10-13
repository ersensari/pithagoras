FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl \
    && rm -rf /var/lib/apt/lists/*

# mcp 2.x renamed FastMCP to MCPServer and changed its API - pin <2 to keep
# the simpler v1 FastMCP decorator API server.py uses.
RUN pip install --no-cache-dir mem0ai "mcp[cli]<2" uvicorn

COPY server.py /app/server.py
WORKDIR /app

ENV PORT=3900
EXPOSE 3900
CMD ["python3", "server.py"]
