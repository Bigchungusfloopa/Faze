# Document Intelligence Agent

The routing + multi-pipeline + grounded-retrieval agent for the Document
Intelligence & Multi-Source Search project. This module owns:
**Document Upload → Multi-Pipeline Processing → Semantic Retrieval →
Multi-Source Context → AI-Powered Response → Evidence & Source Attribution**

## Why it won't fabricate answers

Anti-hallucination is enforced at three independent layers, not just a
prompt instruction:

1. **Retrieval gate** — if nothing relevant is found in the vector store
   (distance above threshold), the LLM is never even called; the agent
   returns the fixed "insufficient information" response directly.
2. **Prompt contract** — the system prompt requires every claim to carry a
   `[filename, page X]` citation and gives Gemini an explicit refusal
   phrase to use when context doesn't cover the question.
3. **Post-hoc validator** — after generation, the answer's keywords are
   checked for real overlap with the retrieved chunk text. If an answer
   doesn't ground against anything retrieved, it is **withheld**, not
   trusted — this catches cases where the LLM ignores its instructions.

Conflicting information across sources (e.g. two policy docs with
different numbers) is surfaced explicitly rather than silently resolved.

## Project layout

```
agent/
  router.py         # classifies uploads into TEXT_PDF / SCANNED_PDF / TABLE / CSV / EXCEL / DOCX / PRESENTATION / TEXT_DOC / IMAGE / OCR
  extractors.py      # extraction per pipeline (PDF, CSV, XLSX, DOCX, PPTX, TXT, OCR, Images)
  ocr_agent.py      # dedicated OCRAgent: high-DPI rendering, transcription, key-value entity extraction & visual QA
  xlsx_engine.py    # generic dataset-independent tabular intelligence engine
  chunker.py          # page/table-level -> retrieval chunks, keeps provenance metadata
  vector_store.py     # Chroma wrapper (add / query)
  gemini_client.py    # GeminiClient (real) + MockGeminiClient (offline dev/test)
  rag_agent.py        # orchestrator: ingest() / query(), 3-layer anti-fabrication guard
tests/
  generate_test_docs.py  # builds synthetic fixtures for every pipeline
  test_agent.py           # core agent tests: routing, pipelines, grounding, refusal, conflicts, multi-turn
  test_ocr_agent.py       # dedicated OCR agent tests: multi-page scans, entity extraction, grounded QA
  test_xlsx_engine.py     # generic tabular tests
  test_file_formats.py    # exhaustive format coverage (.ppt, .docs, .pdf, .jpeg, images, excel)
demo.py               # CLI to ingest files and ask questions interactively
```

## Supported File Formats & Multi-Pipeline Matrix

| Category | File Extensions | Pipeline | Engine / Processing Capabilities |
| :--- | :--- | :--- | :--- |
| **PDF Documents** | `.pdf` | `text_pdf`, `table`, `scanned_pdf`, `ocr` | PyMuPDF text stream, pdfplumber grid-line tables, or 200-DPI rasterization |
| **Presentations** | `.pptx`, `.ppt` | `presentation` | `python-pptx` per-slide layout, titles, bullet bodies, tables, presenter notes & legacy fallback |
| **Word Documents** | `.docx`, `.docs`, `.doc` | `docx` | `python-docx` headings, body paragraphs, XML tables & legacy binary string fallback |
| **Excel & Spreadsheets**| `.xlsx`, `.xls`, `.xlsm`, `.xlsb` | `excel` | Dynamic multi-sheet schema discovery, cell lookups, grouping, joins & statistics |
| **Delimited Data** | `.csv`, `.tsv` | `csv` | Chunked tabular row streaming & pandas statistical engine integration |
| **Photos & Images** | `.jpeg`, `.jpg`, `.png`, `.webp`, `.bmp`, `.tiff`, `.tif`, `.gif`, `.ico`, `.svg` | `image`, `ocr` | Vision model transcription, factual captioning, document classification & entity extraction |
| **Text & Markup** | `.txt`, `.md`, `.markdown`, `.json`, `.xml`, `.html`, `.log`, `.yaml`, `.yml`, `.rst`, `.rtf` | `text_doc` | Multi-encoding (UTF-8, Latin-1, CP1252) chunking with header boundary preservation |

## Running it

```bash
pip install -r requirements.txt

# generate synthetic test docs (clean pdf, table pdf, scanned pdf, image)
PYTHONPATH=. python3 tests/generate_test_docs.py

# run the test suite (offline, uses MockGeminiClient)
PYTHONPATH=. python3 -m pytest tests/test_agent.py -v

# interactive demo, offline
PYTHONPATH=. python3 demo.py

# interactive demo with your own files
PYTHONPATH=. python3 demo.py --files path/to/a.pdf path/to/b.png

# one-shot question
PYTHONPATH=. python3 demo.py --query "What is the refund policy?"
```

## Switching to real Gemini for the live demo

Create or edit `.env` in the project root:
```bash
GEMINI_API_KEY="your-key-here"
```
Or export it directly:
```bash
export GEMINI_API_KEY="your-key-here"
```

Run demo with real Gemini:
```bash
PYTHONPATH=. python3 demo.py --files your_real_docs/*.pdf
```
To force offline mock mode even when `.env` has a key:
```bash
PYTHONPATH=. python3 demo.py --offline
```
`agent.gemini_client.get_llm_client()` auto-detects `GEMINI_API_KEY` (loaded automatically from `.env`) and
returns the real `GeminiClient` instead of the mock.

Recommended real models (update in `gemini_client.py` if your account uses
different names): `gemini-2.5-flash` for synthesis (fast + cheap, good
enough for grounded QA), `text-embedding-004` for embeddings. Use
`gemini-2.5-pro` instead of flash if judges probe with harder multi-hop
questions and you have budget for the latency.

## Integrating with teammates

- **Frontend/backend contract**: wrap `DocumentIntelligenceAgent.ingest(path)`
  and `.query(question, session_id)` in FastAPI endpoints, e.g.:
  - `POST /upload` → save file → `agent.ingest(path)` → return pipeline+status
  - `POST /query` → `{question, session_id}` → `agent.query(...)` → return
    `{answer, citations, grounded, insufficient_evidence, conflicting}`
- `AgentResponse` already has everything the "Evidence & Source Attribution"
  requirement needs (`citations` list with filename/page/chunk_type/snippet)
  — just serialize it.
- One `DocumentIntelligenceAgent` instance should be shared (module-level
  singleton or app state) across requests so uploaded docs persist across
  queries in a session; pass `persist_dir="./chroma_data"` if you want the
  index to survive a server restart.

## Dedicated OCR Agent & Pipeline

The system includes a dedicated visual document engine (`OCRAgent` in `agent/ocr_agent.py`) and pipeline (`PipelineType.OCR`):
- **Rasterization & Vision Ingestion**: High-DPI page rendering via PyMuPDF (`fitz`) for scanned documents, PDF forms, invoices, and standalone images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tiff`).
- **Document Classification**: Automatic categorization into `invoice`, `receipt`, `form`, `letter`, `policy_document`, or `general`.
- **Deterministic Entity Extraction**: Regex & structured parser extracting fields like `Date`, `Reference_Number` (Invoice/Ticket #), `Total_Amount`, `Subtotal`, `Tax`, `Email`, and `Phone`.
- **Visual Element Detection**: Identifies `table`, `signature`, `stamp`, and `handwriting`.
- **Visual Question-Answering**: Dedicated query interface supporting full transcriptions, targeted field lookups, and strictly-grounded visual Q&A with refusal guards.
- **Vector Store Sync**: `OCRAgent.to_chunks()` emits standardized chunks tagged `chunk_type="ocr"` with page-level provenance.

## Known trade-offs (say these out loud to judges, don't hide them)

- Scanned/image OCR goes through Gemini Vision rather than
  Tesseract+OpenCV preprocessing — much faster to build and more robust to
  noisy scans, at the cost of higher per-page latency/token cost and no
  bounding-box output.
- The condense-question step for follow-ups is a cheap pronoun/length
  heuristic, not an LLM call, to save latency/cost. Swap
  `_condense_question` for an actual Gemini call if you have time budget
  left and want more robust multi-turn resolution.
- Table extraction uses pdfplumber's ruling-line detector; a table with no
  visible grid lines (rare, but exists) will fall through to the plain
  text pipeline instead.
