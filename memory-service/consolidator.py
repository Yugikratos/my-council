"""Background Memory Consolidation (Sleep Cycle ETL) for My Council.

Asynchronous batch process that runs during idle intervals to:
1. Extract unconsolidated raw turns (bounded micro-batches <= 10).
2. Distill enduring facts, preferences, and milestones via local Ollama (gemma3:4b).
3. Enforce privacy boundaries (general facts -> public; 1-on-1 secrets -> private).
4. Semantically deduplicate against existing consolidated facts (distance < 0.15).
5. Append raw turns to a persistent JSONL archive and prune them from ChromaDB.
"""
import os
import json
import uuid
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

import config

ARCHIVE_PATH = os.path.join(config.DATA_DIR, "raw_turns_archive.jsonl")

DISTILLATION_SYSTEM_PROMPT = """You are a precise data engineering fact extraction system.
Analyze the following conversational turns between a user and AI Council personas.
Extract persistent, enduring facts about:
1. The user's biography, career, skills, active projects, and preferences.
2. Significant relationship milestones or commitments with specific personas.

STRICT CONSTRAINTS:
- Discard all greetings, pleasantries, small talk, transient jokes, and temporary status.
- Discard questions without answers.
- Classify visibility:
  - "public": general user knowledge (career, skills, hobbies, preferences). Target must be "all".
  - "private": confidential 1-on-1 emotional rapport or secrets shared only with a specific persona. Target must be that persona's id.
- Output MUST be strictly a JSON list of objects in this exact format:
[
  {
    "fact": "The user is studying compiler design in Rust.",
    "category": "project",
    "visibility": "public",
    "target": "all"
  }
]
If no enduring facts exist in the turns, output an empty JSON list: []
"""

def call_ollama_distill(
    turns_text: str,
    ollama_url: str = "http://127.0.0.1:11434",
    model: str = "gemma3:4b",
    timeout_sec: float = 60.0,
    is_aborted: Optional[Callable[[], bool]] = None
) -> List[Dict]:
    """Call Ollama gemma3:4b with streaming JSON format to allow instant mid-generation preemption."""
    endpoint = f"{ollama_url.rstrip('/')}/api/chat"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": DISTILLATION_SYSTEM_PROMPT},
            {"role": "user", "content": f"Extract enduring facts from these conversational turns:\n\n{turns_text}"}
        ],
        "format": "json",
        "stream": True,
        "options": {
            "num_ctx": 4096,
            "temperature": 0.2
        }
    }
    
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    content = ""
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        for line in resp:
            # Check preemption condition between streamed token chunks.
            # Closing the response terminates the connection, signaling Ollama
            # to immediately halt generation and free GPU compute for live chat.
            if is_aborted and is_aborted():
                resp.close()
                return []
            if not line:
                continue
            try:
                chunk_data = json.loads(line.decode("utf-8"))
                token = chunk_data.get("message", {}).get("content", "")
                if token:
                    content += token
            except Exception:
                continue

    try:
        parsed = json.loads(content)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict) and "facts" in parsed and isinstance(parsed["facts"], list):
            return parsed["facts"]
        return []
    except Exception:
        return []

def consolidate_batch(
    collection,
    batch_size: int = 10,
    ollama_url: str = "http://127.0.0.1:11434",
    model: str = "gemma3:4b",
    is_aborted: Optional[Callable[[], bool]] = None
) -> dict:
    """Execute one bounded micro-batch of memory consolidation."""
    if is_aborted and is_aborted():
        return {"status": "aborted", "processed": 0}

    # 1. EXTRACT: fetch unconsolidated raw turns
    raw_data = collection.get(
        where={"memory_type": {"$eq": "raw_turn"}},
        limit=batch_size,
        include=["metadatas", "documents"]
    )
    
    ids = raw_data.get("ids", [])
    metadatas = raw_data.get("metadatas", [])
    
    if not ids:
        return {"status": "idle", "processed": 0, "facts_added": 0}

    if is_aborted and is_aborted():
        return {"status": "aborted", "processed": 0}

    # Format turns for prompt
    formatted_turns = []
    for i, meta in enumerate(metadatas):
        p_name = meta.get("persona_name", meta.get("persona_id", "Council"))
        p_id = meta.get("persona_id", "all")
        u_msg = meta.get("user_message", "")
        r_msg = meta.get("reply", "")
        formatted_turns.append(
            f"Turn {i+1} [User to {p_name} ({p_id})]: \"{u_msg}\"\nReply: \"{r_msg}\""
        )
    turns_text = "\n\n".join(formatted_turns)

    # 2. TRANSFORM: LLM fact distillation with stream preemption check
    try:
        extracted_facts = call_ollama_distill(
            turns_text,
            ollama_url=ollama_url,
            model=model,
            is_aborted=is_aborted
        )
    except Exception as e:
        if is_aborted and is_aborted():
            return {"status": "aborted", "processed": 0}
        return {"status": "error", "error": f"Ollama distillation failed: {str(e)}", "processed": 0}

    if is_aborted and is_aborted():
        return {"status": "aborted", "processed": 0}

    # 3. DEDUPLICATION & LOAD: insert non-duplicate facts
    facts_added = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for item in extracted_facts:
        fact_str = item.get("fact", "").strip()
        if not fact_str:
            continue

        target = item.get("target", "all")
        visibility = item.get("visibility", "public")
        
        # Check if an identical or near-identical fact already exists
        total_facts = collection.count()
        is_dup = False
        if total_facts > 0:
            try:
                dup_check = collection.query(
                    query_texts=[fact_str],
                    n_results=1,
                    where={"memory_type": {"$eq": "consolidated_fact"}}
                )
                distances = dup_check.get("distances", [[]])[0]
                if distances and distances[0] < 0.15:
                    is_dup = True
            except Exception:
                is_dup = False

        if not is_dup:
            fact_id = str(uuid.uuid4())
            collection.add(
                ids=[fact_id],
                documents=[fact_str],
                metadatas=[{
                    "persona_id": target,
                    "persona_name": "Council Knowledge",
                    "timestamp": now_iso,
                    "user_message": fact_str,
                    "reply": "",
                    "source": "consolidation",
                    "target": target,
                    "visibility": visibility,
                    "memory_type": "consolidated_fact",
                    "schema_version": 2
                }]
            )
            facts_added += 1

    # 4. ARCHIVE & PRUNE: append to JSONL archive and remove from active vector index
    os.makedirs(os.path.dirname(ARCHIVE_PATH), exist_ok=True)
    with open(ARCHIVE_PATH, "a", encoding="utf-8") as f:
        for item_id, meta in zip(ids, metadatas):
            archive_entry = {
                "id": item_id,
                "archived_at": now_iso,
                "metadata": meta
            }
            f.write(json.dumps(archive_entry) + "\n")

    # Prune processed raw turns from ChromaDB
    collection.delete(ids=ids)

    return {
        "status": "completed",
        "processed": len(ids),
        "facts_added": facts_added,
        "remaining_raw": collection.count()
    }

