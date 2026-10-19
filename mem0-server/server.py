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
import threading

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mem0 import Memory
from starlette.concurrency import run_in_threadpool
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

# DNS-rebinding protection stays on, but the hosts that really reach this
# server must be listed: LiteLLM's MCP gateway calls it by the docker bridge
# gateway address, and a Host it does not expect answers 421 Misdirected Request.
_LOCAL_HOSTS = ["127.0.0.1:*", "localhost:*", "172.20.0.1:*", "172.17.0.1:*"]
mcp = FastMCP(
    "mem0-memory",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_LOCAL_HOSTS,
        allowed_origins=[f"http://{h}" for h in _LOCAL_HOSTS],
    ),
)


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
    result = memory.search(query, filters={"user_id": USER_ID}, top_k=8)
    found = result.get("results", []) if isinstance(result, dict) else result
    if not found:
        return "No relevant memories found."
    return "\n".join(f"- {m.get('memory', m)}" for m in found)


# --- plain HTTP routes for the Pithagoras memory page (same bearer token) ---
# mem0's client is synchronous and not safe to call from two threads at once
# (embedded Qdrant), so every call goes through one lock, MCP tools included.
_memory_lock = threading.Lock()

MAX_CONTENT_CHARS = 20_000
MAX_PAGE = 200
# mem0's get_all takes top_k, not offset: it returns the first top_k records
# in store order, so paging newest-first needs the whole store in hand first.
# Fine for a personal memory; raise it if the store ever outgrows this.
LIST_SCAN = 10_000


class NotFound(Exception):
    pass


def _item(m: dict) -> dict:
    return {
        "id": str(m.get("id", "")),
        "memory": m.get("memory", ""),
        "created_at": m.get("created_at"),
        "updated_at": m.get("updated_at"),
        "metadata": m.get("metadata") or {},
    }


def _get_item(memory_id: str) -> dict:
    m = memory.get(memory_id)
    if m is None:
        raise NotFound()
    return _item(m)


def _list_page(limit: int, offset: int) -> dict:
    found = memory.get_all(filters={"user_id": USER_ID}, top_k=LIST_SCAN).get("results", [])
    newest_first = sorted(found, key=lambda m: m.get("created_at") or "", reverse=True)
    page = newest_first[offset : offset + limit]
    return {"results": [_item(m) for m in page], "total": len(found), "limit": limit, "offset": offset}


def _search(query: str, limit: int) -> dict:
    found = memory.search(query, filters={"user_id": USER_ID}, top_k=limit).get("results", [])
    return {"results": [_item(m) for m in found]}


def _add(content: str) -> dict:
    result = memory.add(content, user_id=USER_ID)
    out = []
    for e in result.get("results", []) if isinstance(result, dict) else result:
        # mem0's add() reports only the id and text; the stored record has the timestamps.
        stored = memory.get(e["id"]) if e.get("id") else None
        item = _item(stored) if stored else _item({"id": e.get("id"), "memory": e.get("memory", "")})
        out.append({**item, "event": e.get("event", "ADD")})
    return {"results": out}


def _update(memory_id: str, content: str) -> dict:
    if memory.get(memory_id) is None:
        raise NotFound()
    memory.update(memory_id, text=content)
    return _get_item(memory_id)


def _delete(memory_id: str) -> dict:
    if memory.get(memory_id) is None:
        raise NotFound()
    memory.delete(memory_id)
    return {"ok": True, "id": memory_id}


async def _call(fn, *args) -> JSONResponse:
    def locked():
        with _memory_lock:
            return fn(*args)

    try:
        return JSONResponse(await run_in_threadpool(locked))
    except NotFound:
        return JSONResponse({"error": "memory not found"}, status_code=404)
    except Exception as e:  # mem0 / its LLM or embedder failing: say what failed
        return JSONResponse({"error": f"memory backend failed: {e}"}, status_code=500)


def _bounded_int(request, name: str, default: int, low: int, high: int):
    raw = request.query_params.get(name)
    if raw is None:
        return default, None
    try:
        value = int(raw)
    except ValueError:
        value = None
    if value is None or not low <= value <= high:
        return None, JSONResponse({"error": f"{name} must be an integer {low}-{high}"}, status_code=400)
    return value, None


async def _json_content(request):
    try:
        body = await request.json()
    except ValueError:
        return None, JSONResponse({"error": "body must be JSON"}, status_code=400)
    content = body.get("content") if isinstance(body, dict) else None
    if not isinstance(content, str) or not content.strip():
        return None, JSONResponse({"error": "content (non-empty text) is required"}, status_code=400)
    if len(content) > MAX_CONTENT_CHARS:
        return None, JSONResponse({"error": f"content is longer than {MAX_CONTENT_CHARS} characters"}, status_code=400)
    return content.strip(), None


async def list_memories(request):
    limit, err = _bounded_int(request, "limit", 50, 1, MAX_PAGE)
    if err:
        return err
    offset, err = _bounded_int(request, "offset", 0, 0, LIST_SCAN)
    if err:
        return err
    return await _call(_list_page, limit, offset)


async def search_memories(request):
    q = (request.query_params.get("q") or "").strip()
    if not q:
        return JSONResponse({"error": "q is required"}, status_code=400)
    limit, err = _bounded_int(request, "limit", 8, 1, MAX_PAGE)
    if err:
        return err
    return await _call(_search, q, limit)


async def add_memory(request):
    content, err = await _json_content(request)
    if err:
        return err
    return await _call(_add, content)


async def update_memory(request):
    content, err = await _json_content(request)
    if err:
        return err
    return await _call(_update, request.path_params["memory_id"], content)


async def delete_memory(request):
    return await _call(_delete, request.path_params["memory_id"])


app_routes = [
    ("/memories", list_memories, ["GET"]),
    ("/memories", add_memory, ["POST"]),
    ("/memories/search", search_memories, ["GET"]),
    ("/memories/{memory_id}", update_memory, ["PUT"]),
    ("/memories/{memory_id}", delete_memory, ["DELETE"]),
]


class BearerAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.headers.get("authorization") != f"Bearer {BEARER_TOKEN}":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)


app = mcp.streamable_http_app()
for _path, _endpoint, _methods in app_routes:
    app.add_route(_path, _endpoint, methods=_methods)
app.add_middleware(BearerAuthMiddleware)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 3900)))
