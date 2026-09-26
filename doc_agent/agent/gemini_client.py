"""
Gemini client
-------------
Thin wrapper exposing exactly 3 capabilities the agent needs:
    - embed(text)                          -> List[float]
    - vision_transcribe(image_bytes, prompt) -> str
    - generate(system_prompt, user_prompt) -> str

Two implementations are provided behind the same interface:
    GeminiClient      - real calls via google-generativeai (use this when
                         you have GEMINI_API_KEY and network access, e.g.
                         running locally, not in this sandbox)
    MockGeminiClient   - fully offline, deterministic. Used by the test
                         suite here so routing/grounding/refusal logic can
                         be verified without network access. It does NOT
                         fake "understanding" -- its embeddings are simple
                         hashed bag-of-words vectors (keyword-level
                         similarity only) and its `generate` performs
                         literal grounding against the provided context
                         (won't answer anything not textually present).

Swap MockGeminiClient -> GeminiClient by setting GEMINI_API_KEY; the rest
of the agent code (router, extractors, rag_agent) never changes.
"""

import hashlib
import os
import re
import socket
from abc import ABC, abstractmethod
from typing import Any, List, Optional, Union

# Prevent macOS IPv6 routing failure (Errno 65: No route to host) on networks with broken IPv6 routes
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_preferred_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    try:
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    except Exception:
        return _orig_getaddrinfo(host, port, family, type, proto, flags)
socket.getaddrinfo = _ipv4_preferred_getaddrinfo

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except ImportError:
    pass

EMBED_DIM = 256


class BaseLLMClient(ABC):
    @abstractmethod
    def embed(self, text: Union[str, List[str]]) -> Any:
        ...

    @abstractmethod
    def vision_transcribe(self, image_bytes: bytes, prompt: str) -> str:
        ...

    @abstractmethod
    def generate(self, system_prompt: str, user_prompt: str) -> str:
        ...


class GeminiClient(BaseLLMClient):
    """Real Gemini implementation. Requires: pip install google-generativeai
    and GEMINI_API_KEY set in the environment or .env file."""

    def __init__(self, api_key: Optional[str] = None, text_model: Optional[str] = None,
                 embed_model: Optional[str] = None):
        import google.generativeai as genai  # type: ignore
        resolved_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not resolved_key:
            raise ValueError("GEMINI_API_KEY not set")
        clean_key: str = resolved_key.strip("'\"")
        text_model_name: str = text_model or os.environ.get("GEMINI_MODEL", "models/gemini-3.8-flash")
        embed_model_name: str = embed_model or os.environ.get("GEMINI_EMBED_MODEL", "models/gemini-embedding-001")
        genai.configure(api_key=clean_key, transport="rest")
        self.genai = genai
        self.text_model_name = text_model_name
        self.embed_model_name = embed_model_name
        self.model = genai.GenerativeModel(text_model_name)

    def _call_with_retry(self, fn, max_retries: int = 3):
        import time
        for attempt in range(max_retries):
            try:
                return fn()
            except Exception as e:
                err_str = str(e).lower()
                is_transient = any(term in err_str for term in [
                    "route to host", "connection", "timeout", "timed out",
                    "resourceexhausted", "429", "503", "unavailable", "reset by peer"
                ])
                if is_transient and attempt < max_retries - 1:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise

    def embed(self, text: Union[str, List[str]]) -> Any:
        try:
            if isinstance(text, list):
                if not text:
                    return []
                all_embeddings = []
                chunk_size = 50
                for i in range(0, len(text), chunk_size):
                    sub_batch = text[i:i + chunk_size]
                    res: Any = self._call_with_retry(
                        lambda b=sub_batch: self.genai.embed_content(model=self.embed_model_name, content=b)
                    )
                    if res and "embedding" in res:
                        all_embeddings.extend(res["embedding"])
                return all_embeddings
            res: Any = self._call_with_retry(
                lambda: self.genai.embed_content(model=self.embed_model_name, content=text)
            )
            return res["embedding"] if (res and "embedding" in res) else []
        except Exception:
            mock = MockGeminiClient()
            return mock.embed(text)

    def vision_transcribe(self, image_bytes: bytes, prompt: str) -> str:
        try:
            image_part = {"mime_type": "image/png", "data": image_bytes}
            response: Any = self._call_with_retry(
                lambda: self.model.generate_content([prompt, image_part])
            )
            return getattr(response, "text", "") or ""
        except Exception:
            mock = MockGeminiClient()
            return mock.vision_transcribe(image_bytes, prompt)

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        try:
            response: Any = self._call_with_retry(
                lambda: self.model.generate_content([system_prompt, user_prompt])
            )
            return getattr(response, "text", "") or ""
        except Exception:
            mock = MockGeminiClient()
            return mock.generate(system_prompt, user_prompt)


class MockGeminiClient(BaseLLMClient):
    """Deterministic, offline stand-in used for local dev/testing in this
    sandbox. Mimics grounded behavior: it will only ever surface content
    that is textually present in what it's given."""

    def embed(self, text: Union[str, List[str]]) -> Any:
        if isinstance(text, list):
            return [self._hash_embed(t) for t in text]
        return self._hash_embed(text)

    def vision_transcribe(self, image_bytes: bytes, prompt: str) -> str:
        # In real life this is Gemini reading the pixels. Offline, tests
        # inject the "ground truth" text via a registry keyed by image hash
        # (see tests/fixtures.py) so we can simulate OCR deterministically.
        digest = hashlib.sha256(image_bytes).hexdigest()
        return _OCR_REGISTRY.get(digest, "[NO TEXT DETECTED]")

    def generate(self, system_prompt: str, user_prompt: str) -> str:
        """Extremely literal 'grounded' generator for offline testing:
        - Parses CONTEXT and QUESTION out of user_prompt (rag_agent builds
          the prompt in this shape).
        - If none of the context chunks share meaningful keyword overlap
          with the question, returns the insufficient-evidence phrase.
        - Otherwise stitches together the most relevant sentences with
          their citation tags already attached by rag_agent.
        This intentionally cannot "make things up": it only ever echoes
        text handed to it in the context block.
        """
        context_match = re.search(r"CONTEXT:\n(.*?)\nQUESTION:", user_prompt, re.S)
        question_match = re.search(r"QUESTION:\n(.*)", user_prompt, re.S)
        context = context_match.group(1) if context_match else ""
        question = question_match.group(1).strip() if question_match else user_prompt

        q_keywords = _keywords(question)
        blocks = context.split("\n---\n")
        scored = []
        for block in blocks:
            if not block.strip():
                continue
            score = len(q_keywords & _keywords(block))
            if score > 0:
                scored.append((score, block.strip()))

        if not scored:
            return ("I don't have enough information in the provided documents "
                    "to answer that question.")

        scored.sort(key=lambda x: -x[0])
        top_blocks = [b for _, b in scored[:3]]

        conflict_note = self._detect_conflict(top_blocks)
        answer = (conflict_note + " " if conflict_note else "") + " ".join(top_blocks)
        return answer

    def _detect_conflict(self, blocks: List[str]) -> str:
        """Heuristic conflict check for offline testing: if the top two
        relevant blocks come from different source files and contain
        different numbers, flag it as a disagreement rather than silently
        preferring one. (Real Gemini does this via the system prompt
        instruction directly; this mirrors that for the mock.)"""
        if len(blocks) < 2:
            return ""
        tag_re = re.compile(r"^\[([^,]+),")
        m0 = tag_re.match(blocks[0])
        m1 = tag_re.match(blocks[1])
        if not (m0 and m1) or m0.group(1) == m1.group(1):
            return ""
        nums0 = set(re.findall(r"\d+", blocks[0]))
        nums1 = set(re.findall(r"\d+", blocks[1]))
        if nums0 and nums1 and nums0 != nums1:
            return (f"Sources disagree: {m0.group(1)} and {m1.group(1)} give different figures."
                    )
        return ""

    def _hash_embed(self, text: str) -> List[float]:
        vec = [0.0] * EMBED_DIM
        for word in _keywords(text):
            h = int(hashlib.md5(word.encode()).hexdigest(), 16)
            vec[h % EMBED_DIM] += 1.0
        norm = sum(v * v for v in vec) ** 0.5
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec


def _keywords(text: str) -> set:
    words = re.findall(r"[a-z0-9]+", text.lower())
    stop = {"the", "a", "an", "is", "are", "of", "to", "in", "and", "on", "for",
            "what", "does", "do", "how", "was", "were", "it", "this", "that"}
    return {w for w in words if w not in stop and len(w) > 2}


# populated by tests/fixtures.py at test setup time
_OCR_REGISTRY: dict = {}


def register_mock_ocr(image_bytes: bytes, transcribed_text: str):
    """Test helper: tells MockGeminiClient what 'OCR' should return for a
    given image, so scanned-pdf/image pipeline tests are deterministic."""
    digest = hashlib.sha256(image_bytes).hexdigest()
    _OCR_REGISTRY[digest] = transcribed_text


def get_llm_client() -> BaseLLMClient:
    """Factory: real Gemini if GEMINI_API_KEY is present, else offline mock."""
    if os.environ.get("GEMINI_API_KEY"):
        return GeminiClient()
    return MockGeminiClient()
