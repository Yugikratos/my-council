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

# --- Storage (loaded once at startup, reused for every request) ------------

# Local, CPU-based embedding (all-MiniLM-L6-v2 via onnxruntime). No network at
# runtime; the model is downloaded once on first use and cached on disk.
embedding_fn = embedding_functions.DefaultEmbeddingFunction()

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


class RetrieveRequest(BaseModel):
    query: str
    n: Optional[int] = None


# --- Endpoints -------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "count": collection.count()}


@app.post("/store")
def store(req: StoreRequest):
    ts = req.timestamp or datetime.now(timezone.utc).isoformat()

    # The embedded document holds BOTH sides of the exchange, so a future query
    # can match on what the user said and on what the persona replied. The clean
    # fields for attribution live in metadata.
    document = f"User: {req.user_message}\n{req.persona_name}: {req.reply}"

    collection.add(
        ids=[str(uuid.uuid4())],
        documents=[document],
        metadatas=[{
            "persona_id": req.persona_id,
            "persona_name": req.persona_name,
            "timestamp": ts,
            "user_message": req.user_message,
            "reply": req.reply,
        }],
    )
    return {"ok": True, "count": collection.count()}


@app.post("/retrieve")
def retrieve(req: RetrieveRequest):
    n = req.n or config.DEFAULT_TOP_N
    total = collection.count()
    if total == 0:
        return {"memories": []}

    res = collection.query(query_texts=[req.query], n_results=min(n, total))
    metas = res.get("metadatas", [[]])[0]
    dists = res.get("distances", [[]])[0]

    memories = [
        {
            "persona_id": meta.get("persona_id"),
            "persona_name": meta.get("persona_name"),
            "timestamp": meta.get("timestamp"),
            "user_message": meta.get("user_message"),
            "reply": meta.get("reply"),
            "distance": dist,
        }
        for meta, dist in zip(metas, dists)
    ]
    return {"memories": memories}


if __name__ == "__main__":
    import uvicorn

    print(f"My Council memory service starting on http://{config.HOST}:{config.PORT}")
    print(f"  Data dir: {config.DATA_DIR}")
    print(f"  Entries currently stored: {collection.count()}")
    uvicorn.run(app, host=config.HOST, port=config.PORT)
