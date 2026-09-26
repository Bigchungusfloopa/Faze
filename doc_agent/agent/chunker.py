"""
Chunker
-------
Splits page-level RawChunks (which can be a whole page of text) into
retrieval-sized windows, while always preserving doc/page/section metadata
on every resulting chunk -- this metadata is what later powers citations
like "[handbook.pdf, page 4]".

Table and OCR/image chunks are generally left intact (usually already
small / atomic) rather than word-split, since splitting a markdown table
mid-row would destroy its meaning.
"""

from dataclasses import dataclass
from typing import List
from uuid import uuid4

from .extractors import RawChunk

DEFAULT_CHUNK_SIZE = 900     # approx characters, not tokens (keeps this dependency-free)
DEFAULT_OVERLAP = 150


@dataclass
class Chunk:
    id: str
    text: str
    doc_id: str
    filename: str
    page_num: int
    chunk_type: str
    section: str = ""


def chunk_raw(raw_chunks: List[RawChunk], chunk_size: int = DEFAULT_CHUNK_SIZE,
              overlap: int = DEFAULT_OVERLAP) -> List[Chunk]:
    out: List[Chunk] = []
    for rc in raw_chunks:
        if rc.chunk_type in ("table", "image_caption") or len(rc.text) <= chunk_size:
            out.append(_to_chunk(rc, rc.text))
            continue

        # sliding window split for long prose/OCR text
        start = 0
        text = rc.text
        while start < len(text):
            end = min(start + chunk_size, len(text))
            window = text[start:end]
            out.append(_to_chunk(rc, window))
            if end == len(text):
                break
            start = end - overlap
    return out


def _to_chunk(rc: RawChunk, text: str) -> Chunk:
    return Chunk(
        id=str(uuid4()),
        text=text,
        doc_id=rc.doc_id,
        filename=rc.filename,
        page_num=rc.page_num or 0,
        chunk_type=rc.chunk_type,
        section=rc.section or "",
    )
