"""
Quick demo / manual-test CLI.

Offline (no API key)   : uses MockGeminiClient on the synthetic sample_docs/
Live (with Gemini)     : export GEMINI_API_KEY=... then point --files at
                          your own PDFs/images

Usage:
    python3 demo.py                                   # offline demo w/ sample_docs
    python3 demo.py --files a.pdf b.png                # ingest your own files
    GEMINI_API_KEY=xxx python3 demo.py --files a.pdf   # real Gemini end-to-end
"""

import argparse
import json
import os
import sys

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except ImportError:
    pass

from agent.gemini_client import get_llm_client, MockGeminiClient
from agent.rag_agent import DocumentIntelligenceAgent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", nargs="*", help="Files to ingest. Defaults to sample_docs/*")
    parser.add_argument("--query", help="Single question to ask, then exit")
    parser.add_argument("--offline", action="store_true", help="Force MockGeminiClient even if API key is set")
    args = parser.parse_args()

    if args.offline:
        os.environ.pop("GEMINI_API_KEY", None)

    if not os.environ.get("GEMINI_API_KEY"):
        print("[demo] No GEMINI_API_KEY set -> running with MockGeminiClient (offline, keyword-grounded).")
        print("[demo] To run with Gemini: set GEMINI_API_KEY in .env or run without --offline.\n")
    else:
        print("[demo] GEMINI_API_KEY found -> using GeminiClient.\n")

    llm = get_llm_client()
    agent = DocumentIntelligenceAgent(llm_client=llm)

    files = args.files
    if not files:
        from tests.generate_test_docs import generate_all
        files = list(generate_all().values())
        print(f"[demo] No --files given, using synthetic sample_docs: {files}\n")

    for f in files:
        result = agent.ingest(f)
        print(f"[ingest] {os.path.basename(f)} -> {result['status']} "
              f"(pipeline={result.get('pipeline')}, chunks={result.get('chunk_count')})")

    print()
    if args.query:
        _ask(agent, args.query)
        return

    print("Type a question (or 'exit'):")
    session_id = "cli"
    while True:
        try:
            q = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not q or q.lower() in ("exit", "quit"):
            break
        _ask(agent, q, session_id=session_id)


def _ask(agent, question, session_id="cli"):
    resp = agent.query(question, session_id=session_id)
    print(f"\nANSWER: {resp.answer}")
    print(f"grounded={resp.grounded} insufficient_evidence={resp.insufficient_evidence} conflicting={resp.conflicting}")
    if resp.citations:
        print("CITATIONS:")
        for c in resp.citations:
            print(f"  - {c['filename']} (page {c['page']}, {c['chunk_type']}): {c['snippet'][:100]}...")
    print()


if __name__ == "__main__":
    main()
