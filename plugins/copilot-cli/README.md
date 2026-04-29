# memsearch — GitHub Copilot CLI Plugin

Persistent semantic memory for [GitHub Copilot CLI](https://github.com/github/copilot-cli). Every session is automatically captured and indexed so the agent can recall past decisions, debugging notes, and project context.

## What it does

| Feature | Details |
|---|---|
| **Auto-capture** | Every user message + agent response is saved to `.memsearch/memory/YYYY-MM-DD.md` at session end |
| **Context injection** | Recent memory is injected at session start via `onSessionStart` hook |
| **`memsearch_search` tool** | Semantic search over all past sessions (agent calls this automatically) |
| **`memsearch_expand` tool** | Expand a search result to its full markdown section |
| **`$memory-recall` skill** | Pull-based recall for targeted queries |

## Requirements

- GitHub Copilot CLI (with extension support)
- Python ≥ 3.10
- `memsearch` or `uvx` (installer handles this)

## Install

```bash
git clone --depth 1 https://github.com/MiraScarfiotti-nbcuni/memsearch.git
bash memsearch/plugins/copilot-cli/scripts/install.sh
```

The installer:
1. Checks/installs memsearch via `uvx` if not found
2. Symlinks `extension.mjs` to `~/.copilot/extensions/memsearch/`
3. Copies the `memory-recall` skill to `~/.agents/skills/`

## Usage

Start a Copilot CLI session as usual — you'll see `[memsearch] Memory active` in the timeline when the extension loads.

**Automatic** — the agent will use `memsearch_search` when it senses questions needing history.

**Manual recall via skill:**
```
$memory-recall what did we decide about the Redis TTL?
```

**Check your memory files:**
```bash
ls .memsearch/memory/
cat .memsearch/memory/$(date +%Y-%m-%d).md
```

## How it works

```
Session start
  └─ onSessionStart hook
       ├─ resolves git root → derives collection name
       ├─ starts background memsearch index
       └─ injects recent memory headings as context

During session
  └─ session.on("user.message") + session.on("assistant.message")
       └─ accumulates turns in memory buffer

Session end
  └─ onSessionEnd hook
       ├─ writes buffered turns to .memsearch/memory/YYYY-MM-DD.md
       └─ triggers background memsearch index
```

Memory files are plain Markdown — human-readable, editable, version-controllable.

## Configuration

```bash
# Switch to a different embedding provider (default: onnx, no API key needed)
memsearch config set embedding.provider openai
memsearch config set embedding.api_key sk-...

# Use a remote Milvus instance instead of local Lite mode
memsearch config set milvus.uri http://localhost:19530
```

See the [memsearch configuration docs](https://zilliztech.github.io/memsearch/configuration/) for all options.

## Uninstall

```bash
rm -f ~/.copilot/extensions/memsearch/extension.mjs
rm -rf ~/.agents/skills/memory-recall
```
