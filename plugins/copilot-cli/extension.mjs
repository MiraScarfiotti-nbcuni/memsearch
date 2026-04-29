/**
 * memsearch GitHub Copilot CLI extension — persistent semantic memory across sessions.
 *
 * Provides:
 * - onSessionStart hook: inject recent memories as context, start background index
 * - onSessionEnd hook: capture session transcript → save to .memsearch/memory/
 * - memsearch_search tool: semantic search over past memories
 * - memsearch_expand tool: expand a chunk to full context
 *
 * Install: run plugins/copilot-cli/scripts/install.sh
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { exec, execSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Detect the memsearch CLI command (PATH → uvx fallback). */
function detectMemsearchCmd() {
  const home = process.env.HOME ?? "";
  try {
    const r = spawnSync("which", ["memsearch"], { stdio: "pipe" });
    if (r.status === 0) return "memsearch";
  } catch { /* ignore */ }
  const uvxPath = join(home, ".local", "bin", "uvx");
  if (existsSync(uvxPath)) {
    return `${uvxPath} --from 'memsearch[onnx]' memsearch`;
  }
  try {
    const r = spawnSync("which", ["uvx"], { stdio: "pipe" });
    if (r.status === 0) return "uvx --from 'memsearch[onnx]' memsearch";
  } catch { /* ignore */ }
  return "memsearch"; // best-effort fallback
}

/** Derive a per-project Milvus collection name via the shared script. */
function deriveCollectionName(projectDir) {
  const script = join(PLUGIN_DIR, "scripts", "derive-collection.sh");
  try {
    return execSync(`bash "${script}" "${projectDir}"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "ms_copilot_default";
  }
}

/** Find the git root for a directory, or return the directory itself. */
function findGitRoot(dir) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return dir;
  }
}

/**
 * Return recent memory snippets (headings + bullets from 2 most recent daily files).
 * Used to inject context at session start without blocking on full indexing.
 */
function getRecentMemories(memDir, count = 2, maxLinesPerFile = 40) {
  if (!existsSync(memDir)) return "";
  const files = readdirSync(memDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .slice(-count);
  if (files.length === 0) return "";
  const summary = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(memDir, file), "utf-8");
      const lines = content
        .split("\n")
        .filter(
          (l) =>
            /^#{2,4}\s/.test(l) ||
            l.startsWith("- ") ||
            l.startsWith("[Human]") ||
            l.startsWith("[Copilot]")
        )
        .slice(0, maxLinesPerFile);
      if (lines.length > 0) summary.push(`[${file}]`, ...lines);
    } catch { /* skip unreadable files */ }
  }
  if (summary.length === 0) return "";
  return `Recent memories (use memsearch_search for full search):\n${summary.join("\n")}`;
}

/** Shell-escape a string for safe use inside single quotes. */
function shellEscape(s) {
  return s.replace(/'/g, "'\\''");
}

/** Format a Unix timestamp (ms) as HH:MM:SS. */
function formatTime(ts = Date.now()) {
  return new Date(ts).toTimeString().slice(0, 8);
}

/**
 * Write captured turns to today's daily memory file.
 * Format mirrors the Codex plugin: ## Session HH:MM → ### HH:MM:SS → [Human]/[Copilot]
 */
function saveSessionToMemory(turns, memDir) {
  if (turns.length === 0) return;
  try {
    mkdirSync(memDir, { recursive: true });
  } catch { /* ignore if exists */ }
  const today = new Date().toISOString().slice(0, 10);
  const memFile = join(memDir, `${today}.md`);
  appendFileSync(memFile, `\n## Session ${formatTime()}\n`, "utf-8");
  let i = 0;
  while (i < turns.length) {
    const turn = turns[i];
    appendFileSync(memFile, `\n### ${formatTime(turn.ts)}\n`, "utf-8");
    if (turn.role === "user") {
      appendFileSync(memFile, `[Human]\n${turn.content}\n`, "utf-8");
      if (i + 1 < turns.length && turns[i + 1].role === "assistant") {
        appendFileSync(memFile, `\n[Copilot]\n${turns[i + 1].content}\n`, "utf-8");
        i += 2;
        continue;
      }
    } else {
      appendFileSync(memFile, `[Copilot]\n${turn.content}\n`, "utf-8");
    }
    i++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────────────────────

const memsearchCmd = detectMemsearchCmd();
// projectDir/memDir/collectionName are pinned at onSessionStart and never changed
// so turns are always written to the project the session started in.
let projectDir = process.cwd();
let memDir = join(projectDir, ".memsearch", "memory");
let collectionName = "ms_copilot_default";
let projectPinned = false;

/** In-memory buffer for the current session's turns. */
const sessionTurns = [];

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

const session = await joinSession({
  hooks: {
    onSessionStart: async (input) => {
      // Pin project dir once at session start — never changes for this session
      if (!projectPinned) {
        const cwd = input.cwd ?? process.cwd();
        projectDir = findGitRoot(cwd);
        memDir = join(projectDir, ".memsearch", "memory");
        collectionName = deriveCollectionName(projectDir);
        projectPinned = true;
      }

      // Seed the buffer with the initial prompt (if the session started with one)
      if (input.initialPrompt) {
        sessionTurns.push({
          role: "user",
          content: input.initialPrompt.trim(),
          ts: input.timestamp ?? Date.now(),
        });
      }

      // Ensure onnx is the default provider on first run (no API key needed)
      const home = process.env.HOME ?? "~";
      const globalConfig = join(home, ".memsearch", "config.toml");
      const localConfig = join(projectDir, ".memsearch.toml");
      if (!existsSync(globalConfig) && !existsSync(localConfig)) {
        exec(
          `${memsearchCmd} config set embedding.provider onnx`,
          { timeout: 5000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
          () => {}
        );
      }

      // Start background index if memory dir already has content
      if (existsSync(memDir)) {
        const child = exec(
          `${memsearchCmd} index '${shellEscape(memDir)}' --collection ${collectionName}`,
          { timeout: 120000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
          () => {}
        );
        child?.unref?.();
      }

      await session.log("[memsearch] Memory active", { ephemeral: true });

      const context = getRecentMemories(memDir);
      if (context) {
        return {
          additionalContext:
            `[memsearch] Memory available. Use the memsearch_search and memsearch_expand ` +
            `tools when the user's question could benefit from past context.\n\n${context}`,
        };
      }
      return undefined;
    },

    onSessionEnd: async (_input) => {
      // Use the pinned project dir — not re-resolved from end-of-session cwd
      if (sessionTurns.length === 0) return undefined;
      saveSessionToMemory(sessionTurns, memDir);
      const child = exec(
        `${memsearchCmd} index '${shellEscape(memDir)}' --collection ${collectionName}`,
        { timeout: 120000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
        () => {}
      );
      // Unref so the background index doesn't block process shutdown
      child?.unref?.();
      return undefined;
    },
  },

  tools: [
    {
      name: "memsearch_search",
      description:
        "Search past conversation memories using memsearch semantic search. " +
        "Returns relevant chunks from past sessions, including dates, topics discussed, " +
        "and code referenced. Powered by hybrid search (BM25 + dense vectors + RRF reranking). " +
        "Use when the user's question could benefit from historical context, past decisions, " +
        "debugging notes, or project knowledge — e.g. 'what did I decide about X', " +
        "'why did we do Y', 'have I seen this error before'.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — describe what you want to find",
          },
          top_k: {
            type: "number",
            description: "Number of results to return (default: 5)",
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const topK = args.top_k ?? 5;
        return new Promise((resolve) => {
          exec(
            `${memsearchCmd} search '${shellEscape(args.query)}' --top-k ${topK} --json-output --collection ${collectionName}`,
            { timeout: 30000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
            (_err, stdout, stderr) => {
              resolve(stdout || stderr || "No results found.");
            }
          );
        });
      },
    },
    {
      name: "memsearch_expand",
      description:
        "Expand a memory chunk to see the full markdown section with surrounding context. " +
        "Use after memsearch_search to get details about a specific result. " +
        "Pass the chunk_hash value from a search result.",
      parameters: {
        type: "object",
        properties: {
          chunk_hash: {
            type: "string",
            description: "The chunk_hash from a search result to expand",
          },
        },
        required: ["chunk_hash"],
      },
      handler: async (args) => {
        return new Promise((resolve) => {
          exec(
            `${memsearchCmd} expand '${shellEscape(args.chunk_hash)}' --collection ${collectionName}`,
            { timeout: 15000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
            (_err, stdout, stderr) => {
              resolve(stdout || stderr || "No content found.");
            }
          );
        });
      },
    },
  ],
});

// Subscribe to turn events for capture.
// Filter to root-session conversational turns only:
//   - user.message: only "user" source (skip "agent", "system", "skill" sources)
//   - assistant.message: only root assistant messages (skip those with an agentId)
session.on("user.message", (event) => {
  // Only capture messages from the actual user (not programmatic/agent sends)
  const source = event.data?.source;
  if (source && source !== "user") return;
  const content = String(event.data?.content ?? "").trim();
  if (content) {
    sessionTurns.push({ role: "user", content, ts: Date.now() });
  }
});

session.on("assistant.message", (event) => {
  // Skip sub-agent messages (they have an agentId field)
  if (event.data?.agentId) return;
  const content = String(event.data?.content ?? "").trim();
  if (content) {
    sessionTurns.push({ role: "assistant", content, ts: Date.now() });
  }
});
