"""Central configuration for the My Council memory service.

Every tunable for the Python side lives here — the one place to change them.
Each value can also be overridden with an environment variable.
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))

# Where ChromaDB persists data on disk. Kept under the project (on D:) so it
# travels with the repo and survives restarts. Gitignored.
DATA_DIR = os.environ.get("COUNCIL_MEMORY_DIR", os.path.join(_HERE, "chroma-data"))

# One shared collection for all six personas — the unified memory pool.
COLLECTION_NAME = "council_memory"

# How many relevant past exchanges RETRIEVE returns by default.
# This is THE place to tune retrieval breadth.
DEFAULT_TOP_N = 4

# Local embedding model. ChromaDB's DefaultEmbeddingFunction runs
# all-MiniLM-L6-v2 on CPU via onnxruntime — fully offline after a one-time
# model download, and it keeps the GPU's VRAM free for Gemma.
EMBEDDING_MODEL = "all-MiniLM-L6-v2"

# Where this service listens; Node talks to it over localhost.
HOST = os.environ.get("COUNCIL_MEMORY_HOST", "127.0.0.1")
PORT = int(os.environ.get("COUNCIL_MEMORY_PORT", "8000"))
