#!/usr/bin/env python3
"""mem0-based long-term memory, as an MCP server - local replacement for
Pithagoras's Understory add-on.

Why: Understory's own memory_query spawns an internal LLM agent that reads
through markdown concept files to answer - no vector index, so latency and
token cost both grow with how much is remembered. mem0 embeds each memory
once and retrieves by vector similarity (Qdrant), which stays fast regardless
of how large the memory store gets.

Fully local, no cloud: Qdrant runs embedded (on-disk, in this same process,
not a separate server - see vector_store.path below), embeddings come from
forgeloop-ai-embed (bge-m3, CPU), and the fact-extraction LLM mem0 uses
internally (deciding what's new vs. a correction to something already known)
is whatever OpenAI-compatible endpoint MEM0_LLM_BASE_URL points at - Strata
today, swappable to a different local model later with no code change.
"""
import os

from mcp.server.fastmcp import FastMCP
from mem0 import Memory
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

USER_ID = "ersen"
BEARER_TOKEN = os.environ["MEM0_BEARER_TOKEN"]

config = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "path": "/data/qdrant",
            "on_disk": True,
            "embedding_model_dims": 1024,
        },
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": "bge-m3",
            "openai_base_url": os.environ.get("MEM0_EMBEDDER_BASE_URL", "http://127.0.0.1:8089/v1"),
            "api_key": "none",
            "embedding_dims": 1024,
        },
    },
    "llm": {
        "provider": "openai",
        "config": {
            "model": os.environ.get("MEM0_LLM_MODEL", "swift-1.5-iq3_xxs"),
            "openai_base_url": os.environ.get("MEM0_LLM_BASE_URL", "http://127.0.0.1:10084/v1"),
            "api_key": os.environ.get("MEM0_LLM_API_KEY", "none"),
        },
    },
}

memory = Memory.from_config(config)

mcp = FastMCP("mem0-memory")


@mcp.tool()
def memory_add(content: str) -> str:
    """Record new knowledge (facts, preferences, decisions, corrections) to long-term memory.
    Pass free-form prose; mem0 decides on its own whether this is new information,
    an update to something already known, or a correction - no need to say which."""
    result = memory.add(content, user_id=USER_ID)
    events = result.get("results", []) if isinstance(result, dict) else result
    if not events:
        return "Nothing new to record."
    lines = [f"{e.get('event', 'ADD')}: {e.get('memory', '')}" for e in events]
    return "\n".join(lines)


@mcp.tool()
def memory_search(query: str) -> str:
    """Search long-term memory with a natural-language question or topic.
    Returns the most relevant remembered facts, most relevant first."""
    result = memory.search(query, filters={"user_id": USER_ID}, limit=8)
    found = result.get("results", []) if isinstance(result, dict) else result
    if not found:
        return "No relevant memories found."
    return "\n".join(f"- {m.get('memory', m)}" for m in found)


class BearerAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.headers.get("authorization") != f"Bearer {BEARER_TOKEN}":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


app = mcp.streamable_http_app()
app.add_middleware(BearerAuthMiddleware)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 3900)))
