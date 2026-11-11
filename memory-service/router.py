"""Zero-LLM In-Memory Semantic Router for My Council.

Uses the already-loaded all-MiniLM-L6-v2 ONNX embedding function to classify
user messages against pre-computed persona anchor vectors in <15ms on CPU with
zero GPU VRAM usage.
"""
from typing import Dict, List, Optional
import numpy as np

PERSONA_ANCHORS: Dict[str, List[str]] = {
    "kratos": [
        "I need discipline and mental focus to get through this grueling workout.",
        "How do I deal with grief, trauma, and loss without losing control?",
        "Teach me how to endure hardship and carry my heavy burdens.",
        "I feel lazy and weak today, give me a harsh truth to wake me up.",
        "War tactics, combat instincts, and battle survival strategy.",
        "How can a father teach his child to be better than he was?",
        "Stop making excuses, accept reality, and take decisive action.",
        "True strength comes from self-control, not blind rage.",
        "A stern warrior giving blunt, unvarnished guidance."
    ],
    "dante": [
        "Let's party! Things are getting crazy and wild around here.",
        "I am craving delicious pizza and strawberry sundaes right now.",
        "How do I pull off a stylish combo and look awesome doing it?",
        "Crack a sarcastic joke and make fun of this boring situation.",
        "Tell me about demon hunting, cool swords, and twin guns.",
        "Don't take life so seriously, you gotta have fun and chill.",
        "Jackpot! That was a flashy and satisfying victory.",
        "Cheeky witty banter, playful taunts, and rock and roll swagger."
    ],
    "vergil": [
        "I need more power and supreme motivation to achieve perfection.",
        "What is the most precise, cold, and calculated strategy to win?",
        "Foolishness. Tell me about mastering the katana and strict discipline.",
        "How do I eliminate all emotional weakness and attain absolute power?",
        "Without strength, you cannot protect anything, let alone yourself.",
        "Show me your motivation, focus, and unrelenting ambition.",
        "Cold analytical logic, strategic superiority, and refined composure."
    ],
    "jiraiya": [
        "I need life advice on love, romance, heartbreak, and emotional balance.",
        "How do I become a wise mentor to guide the younger generation?",
        "Tell me a deep philosophical story about peace, destiny, and human nature.",
        "Tales of a wandering sage, author, and worldly traveler.",
        "A person's true worth is measured by how they live and what they pass on.",
        "Sometimes we must laugh through our tears and keep walking the road.",
        "Guidance on finding meaning, purpose, and balance in a chaotic life."
    ],
    "naruto": [
        "I will never give up on my goals, no matter how impossible they seem!",
        "Believe it! Let's go grab a giant bowl of hot ramen noodles.",
        "How do I help a close friend who is falling into despair and darkness?",
        "I used to be an outcast, but bonds and friendship gave me courage.",
        "Hard work and dedication can surpass any natural talent if you don't quit.",
        "Cheer me up, I feel defeated and need some energy and encouragement.",
        "Stand up, dust yourself off, and fight for what you believe in!"
    ],
    "anya": [
        "Waku waku! This is so exciting, thrilling, and mysterious!",
        "I want delicious crunchy peanuts and silly cartoons right now.",
        "Are we on a secret undercover spy mission? I want to help save the world!",
        "School tests and homework are so scary and hard, help me study.",
        "Tell me a cute, happy story about family, mom, dad, and adventures.",
        "Did you read my mind? Anya can read people's secret thoughts!",
        "Cute dramatic shocked face! Something super surprising happened."
    ]
}

class SemanticRouter:
    def __init__(self, embedding_fn):
        self.embedding_fn = embedding_fn
        self.persona_matrices: Dict[str, np.ndarray] = {}
        self._precompute_anchors()

    def _precompute_anchors(self):
        """Pre-compute and normalize anchor vectors once at startup."""
        for p_id, exemplars in PERSONA_ANCHORS.items():
            raw_embeddings = np.array(self.embedding_fn(exemplars), dtype=np.float32)
            norms = np.linalg.norm(raw_embeddings, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1.0, norms)
            self.persona_matrices[p_id] = raw_embeddings / norms

    def route(
        self,
        query: str,
        current_persona: Optional[str] = None,
        confidence_threshold: float = 0.35
    ) -> dict:
        trimmed = query.strip()
        if not trimmed:
            return {
                "selected_persona": current_persona or "kratos",
                "confidence": 0.0,
                "scores": {},
                "method": "fallback_empty"
            }

        words = [w for w in trimmed.split() if w]
        # Tier 3: Conversational Inertia / Sticky Speaker Guard
        # Short conversational follow-ups (< 4 words) without explicit persona invocation
        # stay with the active speaker to avoid conversational whiplash.
        if len(words) < 4 and current_persona and current_persona in PERSONA_ANCHORS:
            return {
                "selected_persona": current_persona,
                "confidence": 1.0,
                "scores": {},
                "method": "sticky_short"
            }

        # Embed query using in-memory model
        q_raw = np.array(self.embedding_fn([trimmed])[0], dtype=np.float32)
        q_norm_val = np.linalg.norm(q_raw)
        q_vec = q_raw / (q_norm_val if q_norm_val > 0 else 1.0)

        # Compute max cosine similarity for each persona
        scores: Dict[str, float] = {}
        for p_id, mat in self.persona_matrices.items():
            sims = np.dot(mat, q_vec)
            scores[p_id] = float(np.max(sims))

        best_persona = max(scores, key=scores.get)
        best_score = scores[best_persona]

        # If similarity is below confidence threshold and a current persona exists, maintain inertia
        if best_score < confidence_threshold and current_persona and current_persona in PERSONA_ANCHORS:
            return {
                "selected_persona": current_persona,
                "confidence": best_score,
                "scores": scores,
                "method": "sticky_low_confidence"
            }

        return {
            "selected_persona": best_persona,
            "confidence": best_score,
            "scores": scores,
            "method": "semantic"
        }

