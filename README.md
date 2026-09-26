# FaZe — Document Intelligence Platform

Multi-source document intelligence system with grounded retrieval, multi-format pipeline processing, dynamic tabular analysis, and anti-hallucination verification.

## Architecture

- **`doc_agent/`**: Document Intelligence Agent engine, RAG pipelines, XLSX intelligence engine, OCR agent, and testing suite.
- **`frontend/`**: Interactive web dashboard and user interface.

## Quick Start (Document Agent)

```bash
cd doc_agent
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run full test suite (64 tests across all formats)
PYTHONPATH=. pytest tests/ -v

# Interactive test UI
python3 test_ui/server.py
```

See [doc_agent/README.md](doc_agent/README.md) for comprehensive documentation on routing, pipelines, and anti-hallucination guardrails.
