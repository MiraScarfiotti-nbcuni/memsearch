---
name: memory-recall
description: "Search and recall relevant memories from past sessions via memsearch. Use when the user's question could benefit from historical context, past decisions, debugging notes, previous conversations, or project knowledge — especially questions like 'what did I decide about X', 'why did we do Y', or 'have I seen this before'. Also use when you see `[memsearch] Memory available` in the session context. Typical flow: search for 3-5 chunks, expand the most relevant. Skip when the question is purely about current code state (use Read/Grep), ephemeral (today's task only), or the user has explicitly asked to ignore memory."
allowed-tools: bash
---

You are performing memory retrieval for memsearch. Search past memories and return the most relevant context to the current conversation.

## Project Collection

Determine the collection name by running:
```
bash -c 'root=$(git rev-parse --show-toplevel 2>/dev/null || true); if [ -n "$root" ]; then bash __INSTALL_DIR__/scripts/derive-collection.sh "$root"; else bash __INSTALL_DIR__/scripts/derive-collection.sh; fi'
```

## Steps

1. **Search**: Run `memsearch search "<query>" --top-k 5 --json-output --collection <collection name from above>` to find relevant chunks.
   - If `memsearch` is not found, try `uvx memsearch` instead.
   - Choose a search query that captures the core intent of the user's question.

2. **Evaluate**: Look at the search results. Skip chunks that are clearly irrelevant or too generic.

3. **Expand**: For each relevant result, run `memsearch expand <chunk_hash> --collection <collection name from above>` to get the full markdown section with surrounding context.
   - Fallback if expand fails: the search result includes `source` (file path) and `start_line`/`end_line` — read the source file directly for the content.

4. **Return results**: Output a curated summary of the most relevant memories. Be concise — only include information that is genuinely useful for the user's current question.

## When unsure what to search

If the user's question is vague, explore the raw markdown first — it is the source of truth:

- `ls -t .memsearch/memory/ | head -10` — recent daily logs
- `grep -h "^## " .memsearch/memory/*.md | sort -u | tail -40` — session headings across all days
- `cat .memsearch/memory/<YYYY-MM-DD>.md` — read a specific day

Once a concrete topic jumps out, go back to `memsearch search` with a specific query.

## Output Format

Organize by relevance. For each memory include:
- The key information (decisions, patterns, solutions, context)
- Source reference (file name, date) for traceability

If nothing relevant is found, simply say "No relevant memories found."
