"""My Council — local memory service.

A thin FastAPI wrapper around ChromaDB providing verbatim storage and semantic
retrieval for the shared Council memory. It is one long-lived process: the
embedding model and the persistent Chroma client load ONCE at startup and are
reused for every request (the whole reason we chose a service over per-call
subprocesses).

Endpoints:
  GET  /health    -> { ok, count }                 liveness + entry count
  POST /store     -> persists one verbatim exchange, tagged with persona + time
  POST /retrieve  -> top-N semantically relevant past exchanges for a query
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

import chromadb
from chromadb.utils import embedding_functions
from fastapi import FastAPI
from pydantic import BaseModel

import config
from quality import is_low_value
from router import SemanticRouter
from consolidator import consolidate_batch

# --- Storage (loaded once at startup, reused for every request) ------------

# Local, CPU-based embedding (all-MiniLM-L6-v2 via onnxruntime). No network at
# runtime; the model is downloaded once on first use and cached on disk.
embedding_fn = embedding_functions.DefaultEmbeddingFunction()

# Precompute anchor vectors for zero-LLM in-memory semantic routing (<15ms)
semantic_router = SemanticRouter(embedding_fn)

# Consolidation execution state
is_consolidating = False
abort_consolidation_requested = False

# PersistentClient writes to DATA_DIR and survives restarts.
client = chromadb.PersistentClient(path=config.DATA_DIR)
collection = client.get_or_create_collection(
    name=config.COLLECTION_NAME,
    embedding_function=embedding_fn,
    metadata={"hnsw:space": "cosine"},
)

app = FastAPI(title="My Council Memory")


# --- Request models --------------------------------------------------------

class StoreRequest(BaseModel):
    persona_id: str
    persona_name: str
    user_message: str
    reply: str
    timestamp: Optional[str] = None  # ISO 8601; generated if omitted
    source: Optional[str] = "user"
    target: Optional[str] = None
    visibility: Optional[str] = "private"
    memory_type: Optional[str] = "raw_turn"


class RetrieveRequest(BaseModel):
    query: str
    n: Optional[int] = None
    requester_persona: Optional[str] = None
    visibility: Optional[str] = None


class RouteRequest(BaseModel):
    query: str
    current_persona: Optional[str] = None
    confidence_threshold: Optional[float] = 0.35


class ConsolidateRequest(BaseModel):
    batch_size: Optional[int] = 10


# --- Endpoints -------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "count": collection.count()}


@app.post("/store")
def store(req: StoreRequest):
    # Don't persist low-value exchanges (greetings, "I don't know" non-answers).
    # Keeping junk out of the pool is what stops it polluting / out-ranking real
    # facts on retrieval. Conservative by design — see quality.py.
    if config.STORE_FILTER_ENABLED and is_low_value(req.user_message, req.reply):
        return {"ok": True, "stored": False, "reason": "low-value", "count": collection.count()}

    ts = req.timestamp or datetime.now(timezone.utc).isoformat()
    target = req.target if req.target else req.persona_id
    visibility = req.visibility if req.visibility else "private"
    source = req.source if req.source else "user"
    memory_type = req.memory_type if req.memory_type else "raw_turn"

    # Embed the USER'S words as the retrieval key — that is what future queries
    # (also user messages) match against. This weights retrieval toward what the
    # user actually said, not the persona's phrasing or deflections. The full
    # exchange (reply included) is preserved in metadata for recall/attribution.
    document = req.user_message

    collection.add(
        ids=[str(uuid.uuid4())],
        documents=[document],
        metadatas=[{
            "persona_id": req.persona_id,
            "persona_name": req.persona_name,
            "timestamp": ts,
            "user_message": req.user_message,
            "reply": req.reply,
            "source": source,
            "target": target,
            "visibility": visibility,
            "memory_type": memory_type,
            "schema_version": 2,
        }],
    )
    return {"ok": True, "stored": True, "count": collection.count()}


@app.post("/retrieve")
def retrieve(req: RetrieveRequest):
    n = req.n or config.DEFAULT_TOP_N
    total = collection.count()
    if total == 0:
        return {"memories": []}

    where_filter = None
    if req.requester_persona:
        # Hard RBAC filter: only allow public memories or memories explicitly
        # targeted to the requesting persona (or to 'all').
        where_filter = {
            "$or": [
                {"visibility": {"$eq": "public"}},
                {"target": {"$eq": req.requester_persona}},
                {"target": {"$eq": "all"}},
            ]
        }
    elif req.visibility:
        where_filter = {"visibility": {"$eq": req.visibility}}

    query_kwargs = {
        "query_texts": [req.query],
        "n_results": min(n, total),
    }
    if where_filter:
        query_kwargs["where"] = where_filter

    res = collection.query(**query_kwargs)
    metas = res.get("metadatas", [[]])[0]
    dists = res.get("distances", [[]])[0]

    memories = [
        {
            "persona_id": meta.get("persona_id"),
            "persona_name": meta.get("persona_name"),
            "timestamp": meta.get("timestamp"),
            "user_message": meta.get("user_message"),
            "reply": meta.get("reply"),
            "source": meta.get("source", "user"),
            "target": meta.get("target"),
            "visibility": meta.get("visibility", "public"),
            "memory_type": meta.get("memory_type", "raw_turn"),
            "distance": dist,
        }
        for meta, dist in zip(metas, dists)
    ]
    return {"memories": memories}


@app.post("/route")
def route(req: RouteRequest):
    return semantic_router.route(
        query=req.query,
        current_persona=req.current_persona,
        confidence_threshold=req.confidence_threshold or 0.35,
    )


@app.get("/consolidate/status")
def consolidate_status():
    global is_consolidating
    return {"is_consolidating": is_consolidating}


@app.post("/consolidate/abort")
def consolidate_abort():
    global abort_consolidation_requested
    abort_consolidation_requested = True
    return {"ok": True, "aborted": True}


@app.post("/consolidate")
def consolidate(req: ConsolidateRequest):
    global is_consolidating, abort_consolidation_requested
    if is_consolidating:
        return {"ok": False, "status": "already_running"}

    is_consolidating = True
    abort_consolidation_requested = False
    try:
        def is_aborted():
            return abort_consolidation_requested

        result = consolidate_batch(
            collection=collection,
            batch_size=req.batch_size or 10,
            is_aborted=is_aborted,
        )
        return {"ok": True, **result}
    finally:
        is_consolidating = False
        abort_consolidation_requested = False


if __name__ == "__main__":
    import uvicorn

    print(f"My Council memory service starting on http://{config.HOST}:{config.PORT}")
    print(f"  Data dir: {config.DATA_DIR}")
    print(f"  Entries currently stored: {collection.count()}")
    uvicorn.run(app, host=config.HOST, port=config.PORT)
