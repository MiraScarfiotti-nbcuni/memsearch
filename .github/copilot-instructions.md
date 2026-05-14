# Copilot Instructions for memsearch

## Commands

```bash
# Install (dev)
uv sync --all-extras

# Test — always use python -m pytest to avoid system pytest conflicts
uv run python -m pytest                                              # full suite
uv run python -m pytest tests/test_chunker.py                       # single file
uv run python -m pytest tests/test_store.py::test_upsert_and_search -v  # single test
uv run python -m pytest --cov --cov-report=term-missing             # with coverage

# Lint & format
uv run ruff check src/ tests/
uv run ruff format src/ tests/

# CLI
uv run memsearch --help

# Docs (local preview)
uv run mkdocs serve
```

Pre-commit hooks run `ruff check --fix` and `ruff format` automatically. Install once with `uv run pre-commit install`.

## Architecture

memsearch is a semantic memory search engine that indexes markdown files into Milvus and retrieves them via hybrid search.

**Data flow:**
```
Markdown files → Scanner → Chunker → Embedder → MilvusStore
                                                      ↓
                               User query → Embedder → Hybrid Search (dense + BM25 + RRF) → Results
```

**Core library** (`src/memsearch/`):
- `core.py` — `MemSearch` class: public Python API. All entry points: `index()`, `search()`, `compact()`, `watch()`.
- `store.py` — `MilvusStore`: collection creation, upsert, hybrid search (dense cosine + BM25 sparse + RRF), and cleanup. `chunk_hash` is the VARCHAR primary key.
- `chunker.py` — Splits markdown by headings into `Chunk` dataclasses. `compute_chunk_id()` generates composite IDs matching OpenClaw's format.
- `embeddings/__init__.py` — `EmbeddingProvider` protocol + lazy-loading factory `get_provider()`. Providers: `openai` (default for Python API), `onnx` (default for plugins), `google`, `voyage`, `jina`, `mistral`, `ollama`, `local`.
- `config.py` — Layered TOML config: dataclass defaults → `~/.memsearch/config.toml` → `.memsearch.toml` → CLI flags. All CLI commands call `resolve_config()` first.
- `cli.py` — Click CLI wrapping the Python API.
- `watcher.py` — `watchdog`-based file watcher with debounce.
- `compact.py` — LLM-powered chunk summarization (OpenAI/Anthropic/Gemini).
- `reranker.py` — Optional cross-encoder reranking (ONNX or PyTorch). Disabled by default.

**Plugins** (`plugins/`): Four agent integrations — `claude-code`, `openclaw`, `opencode`, `codex`. All share a `summarize.txt` prompt template maintained in `plugins/_shared/prompts/` and synced via `scripts/sync-prompts.sh`. Template uses `{{AGENT_NAME}}` placeholder.

**Claude Code plugin** (`plugins/claude-code/`) — 4 shell hooks + 1 skill + background watcher:
- Hooks output JSON to stdout: `additionalContext`, `systemMessage`, or `{}`.
- `common.sh` is sourced by every hook. Changes affect all hooks. It derives `COLLECTION_NAME` via `derive-collection.sh` and wraps memsearch calls in `run_memsearch()` / `start_watch()`.
- `stop.sh` has a `stop_hook_active` recursion guard (it calls `claude -p` internally) and sets `MEMSEARCH_NO_WATCH=1`.
- `memory-recall` skill uses `context: fork` — subagent runs search → expand → transcript without sharing the main context window.
- `transcript.py` is plugin-specific (Claude Code JSONL format) — it does not belong in the core library.

## Key Conventions

**Dependency management:** Use `uv` and `pyproject.toml` exclusively — never `pip install` directly. Optional extras: `[google]`, `[voyage]`, `[ollama]`, `[local]`, `[onnx]`, `[all]`.

**Type hints:** All source files use `from __future__ import annotations`. Python 3.10+ minimum.

**Composite chunk ID as primary key:** `hash(source:startLine:endLine:contentHash:model)` — provides natural dedup without a separate cache. Never treat `chunk_hash` as a random UUID.

**Hybrid search:** Every collection has both dense vector and BM25 sparse fields. RRF scores are normalized to `[0, 1]`.

**Remote Milvus:** `query()` requires a filter expression. Use `chunk_hash != ""` as a "match all" filter — Milvus Lite omits this requirement but Milvus Server enforces it.

**Config deprecation:** `[compact]` config section is deprecated in favour of `[llm]` + `[prompts]`. `resolve_config()` emits a `DeprecationWarning` when user config files still contain `[compact]`. Compact CLI resolves as `cfg.llm.* or cfg.compact.*`.

**Markdown is source of truth:** Milvus is a derived index — always rebuildable from `.md` files. Never treat the vector store as authoritative.

**Versioning:** Five independent version numbers. Bump only the component that changed:

| Component | Version file |
|-----------|-------------|
| memsearch (PyPI) | `pyproject.toml` |
| Claude Code plugin | `plugins/claude-code/.claude-plugin/plugin.json` |
| OpenClaw plugin | `plugins/openclaw/package.json` |
| OpenCode plugin | `plugins/opencode/package.json` |
| Codex CLI plugin | *(no version file)* |

**PR titles** must use Conventional Commits prefixes: `feat:`, `fix:`, `docs:`, `ci:`, `chore:`, `refactor:`, `test:`.

**Do not commit** `site/` (mkdocs build output).
