"""My Council — Schema Migration to v2 RBAC Metadata.

Backfills existing ChromaDB vector entries with the v2 RBAC metadata attributes:
  - source: 'user'
  - target: persona_id (or 'all' if none)
  - visibility: 'public' (preserves accessibility for legacy entries)
  - memory_type: 'raw_turn'
  - schema_version: 2
"""
import sys
import os
import chromadb

# Ensure memory-service dir is in sys.path
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import config

def migrate():
    print(f"Connecting to ChromaDB at: {config.DATA_DIR}")
    client = chromadb.PersistentClient(path=config.DATA_DIR)
    
    try:
        collection = client.get_collection(config.COLLECTION_NAME)
    except Exception as e:
        print(f"Collection '{config.COLLECTION_NAME}' not found or error: {e}")
        return

    total = collection.count()
    print(f"Total entries in collection '{config.COLLECTION_NAME}': {total}")
    if total == 0:
        print("No entries to migrate.")
        return

    # Fetch all records
    data = collection.get(include=["metadatas", "documents"])
    ids = data.get("ids", [])
    metadatas = data.get("metadatas", [])
    
    migrated_count = 0
    updated_ids = []
    updated_metas = []

    for item_id, meta in zip(ids, metadatas):
        current_meta = dict(meta) if meta else {}
        needs_update = False

        if "visibility" not in current_meta:
            current_meta["visibility"] = "public"
            needs_update = True
        
        if "target" not in current_meta:
            current_meta["target"] = current_meta.get("persona_id", "all")
            needs_update = True

        if "source" not in current_meta:
            current_meta["source"] = "user"
            needs_update = True

        if "memory_type" not in current_meta:
            current_meta["memory_type"] = "raw_turn"
            needs_update = True

        if "schema_version" not in current_meta or current_meta["schema_version"] != 2:
            current_meta["schema_version"] = 2
            needs_update = True

        if needs_update:
            updated_ids.append(item_id)
            updated_metas.append(current_meta)
            migrated_count += 1

    if updated_ids:
        print(f"Applying migration updates to {len(updated_ids)} records...")
        # ChromaDB allows batch updates
        batch_size = 50
        for i in range(0, len(updated_ids), batch_size):
            batch_ids = updated_ids[i:i + batch_size]
            batch_metas = updated_metas[i:i + batch_size]
            collection.update(ids=batch_ids, metadatas=batch_metas)
        print(f"Successfully migrated {migrated_count} records to schema v2.")
    else:
        print("All records already up to date with schema v2.")

    # Verification: run a quick query test with the v2 filter
    sample_query = collection.query(
        query_texts=["hello"],
        n_results=min(3, total),
        where={
            "$or": [
                {"visibility": {"$eq": "public"}},
                {"target": {"$eq": "kratos"}},
                {"target": {"$eq": "all"}},
            ]
        }
    )
    returned_ids = sample_query.get("ids", [[]])[0]
    print(f"Verification query returned {len(returned_ids)} entries under RBAC filter.")
    print("Migration complete!")

if __name__ == "__main__":
    migrate()

