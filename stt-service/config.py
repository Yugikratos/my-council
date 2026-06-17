"""Central configuration for the My Council STT (speech-to-text) service.

Mirrors memory-service/config.py: every tunable for this Python side lives here,
each overridable with an environment variable.
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))

# faster-whisper model size. "base" (74M, ~145MB download) is the recommended
# starting point on a CPU-only box: it transcribes short push-to-talk clips
# faster than real time on the i7-9750H and is accurate enough for conversational
# English. Bump to "small" (~488MB, ~3x slower) via this env var if you need
# better accuracy and can tolerate the latency. Larger sizes are not advised on
# CPU. (tiny is an option if base feels slow.)
MODEL_SIZE = os.environ.get("COUNCIL_STT_MODEL", "base")

# MUST stay CPU — the GTX 1650's VRAM is reserved for Gemma. int8 quantization
# keeps memory and latency low with minimal accuracy loss on CPU.
DEVICE = "cpu"
COMPUTE_TYPE = os.environ.get("COUNCIL_STT_COMPUTE", "int8")

# Decoding params. beam_size=1 (greedy) is fastest and fine for short utterances;
# raise for marginally better accuracy at a latency cost. LANGUAGE pins English
# to skip auto-detection (faster, avoids mis-detect on short clips); set to an
# empty string to auto-detect.
BEAM_SIZE = int(os.environ.get("COUNCIL_STT_BEAM", "1"))
LANGUAGE = os.environ.get("COUNCIL_STT_LANG", "en")

# Where this service listens; Node talks to it over localhost. Port 8001 avoids
# the app (3000) and the memory service (8000).
HOST = os.environ.get("COUNCIL_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("COUNCIL_STT_PORT", "8001"))
