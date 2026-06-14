"""Memory quality heuristics: decide whether an exchange is worth storing.

Goal: keep the shared memory free of junk that pollutes retrieval — content-free
greetings, and "non-answer" deflections where the persona didn't actually learn
anything about the user (e.g. "what's my name?" -> "I don't know"). Such entries
add noise and, because a stored question echoes a later identical question, can
even out-rank the real fact.

The rules are deliberately CONSERVATIVE: when in doubt, store. We only skip the
obvious low-value cases, and we never drop an exchange where the user clearly
stated a fact about themselves.
"""
import re

# A message made up entirely of greeting/filler words carries no fact to keep.
_GREETING_WORDS = {
    "hi", "hii", "hiii", "hey", "heyy", "heyyy", "heya", "hello", "helloo",
    "yo", "sup", "ssup", "wassup", "wasup", "hiya", "howdy", "oi", "ey", "ello",
    "gm", "gn", "greetings", "there", "good", "morning", "afternoon", "evening",
    "day", "night", "whats", "what's", "up", "whatsup", "hello.", "yt",
}

# Reply markers that mean the persona did NOT actually know anything about the
# user — a deflection / "I don't know" / "you haven't told me".
_NON_ANSWER_RE = re.compile(
    r"\b("
    r"(do|does|did)\s*n'?t\s+(know|recall|remember)|"
    r"(do|does|did)\s+not\s+(know|recall|remember)|"
    r"have\s*n'?t\s+(been\s+told|told)|"
    r"have\s+not\s+(been\s+told|told|stated|indicated|mentioned|said)|"
    r"did\s*n'?t\s+(tell|say|mention)|"
    r"did\s+not\s+(tell|say|mention)|"
    r"you\s+have\s*n'?t\s+(told|said|mentioned|stated)|"
    r"no\s+memory\s+of|"
    r"nothing\s+(has\s+been\s+)?recorded|"
    r"do\s*n'?t\s+have\s+(it|that|any)"
    r")\b",
    re.IGNORECASE,
)

# The user message looks like a question, so on its own it states no new fact.
_QUESTION_START_RE = re.compile(
    r"^(who|what|what's|whats|where|when|why|how|do|does|did|is|are|am|"
    r"can|could|would|will|should|have|has|may|might)\b",
    re.IGNORECASE,
)

# A clear first-person statement that DOES reveal something about the user. Used
# as a guard so an exchange where the user shared a fact is never dropped. The
# verbs are chosen to avoid interrogatives (e.g. "do/did" appear in questions).
_STATEMENT_RE = re.compile(
    r"\b("
    r"i'?m\b|i\s+am\b|i'?ve\b|"
    r"i\s+(work|works|worked|live|lived|study|studied|play|played|like|liked|"
    r"love|loved|hate|hated|feel|felt|need|needed|want|wanted|own|owned|made|"
    r"got|enjoy|prefer)\b|"
    r"my\s+\w+\s+(is|are|was|were|'s)\b"
    r")",
    re.IGNORECASE,
)


def _greeting_only(text: str) -> bool:
    tokens = re.findall(r"[a-z']+", text.lower())
    return bool(tokens) and all(t in _GREETING_WORDS for t in tokens)


def _looks_like_question(text: str) -> bool:
    t = text.strip()
    return t.endswith("?") or bool(_QUESTION_START_RE.match(t))


def is_low_value(user_message: str, reply: str) -> bool:
    """True if this exchange is junk we should NOT persist.

    Conservative — only the obvious cases:
      * empty user message
      * greeting/filler-only user message
      * an unanswerable question that revealed no user fact
        (e.g. "what's my name?" -> "I don't know")
    """
    um = (user_message or "").strip()
    rp = (reply or "").strip()

    if not um:
        return True
    if _greeting_only(um):
        return True
    if _looks_like_question(um) and _NON_ANSWER_RE.search(rp) and not _STATEMENT_RE.search(um):
        return True
    return False
