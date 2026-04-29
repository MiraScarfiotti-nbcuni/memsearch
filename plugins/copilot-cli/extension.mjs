/**
 * memsearch GitHub Copilot CLI extension — thin adapter over memsearch Codex CLI hooks.
 *
 * Delegates all memory logic to the existing Codex CLI bash hook scripts:
 *   onSessionStart       → ../codex/hooks/session-start.sh
 *   onUserPromptSubmitted → ../codex/hooks/user-prompt-submit.sh
 *   session.idle event   → ../codex/hooks/stop.sh  (per-turn, mirrors Codex Stop hook)
 *
 * The only JS-native code is the tool handlers (memsearch_search, memsearch_expand)
 * which need to return values to the LLM, and the turn-tracking event listeners.
 *
 * Install: run plugins/copilot-cli/scripts/install.sh
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { exec, execSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const CODEX_HOOKS = join(PLUGIN_DIR, "..", "codex", "hooks");
const COPILOT_SCRIPTS = join(PLUGIN_DIR, "scripts");

// ─────────────────────────────────────────────────────────────────────────────
// Minimal helpers needed only for the JS tool handlers
// ─────────────────────────────────────────────────────────────────────────────

/** Detect the memsearch CLI command (PATH → uvx fallback). */
function detectMemsearchCmd() {
  const home = process.env.HOME ?? "";
  try {
    const r = spawnSync("which", ["memsearch"], { stdio: "pipe" });
    if (r.status === 0) return "memsearch";
  } catch { /* ignore */ }
  const uvxPath = join(home, ".local", "bin", "uvx");
  if (existsSync(uvxPath)) return `${uvxPath} --from 'memsearch[onnx]' memsearch`;
  try {
    const r = spawnSync("which", ["uvx"], { stdio: "pipe" });
    if (r.status === 0) return "uvx --from 'memsearch[onnx]' memsearch";
  } catch { /* ignore */ }
  return "memsearch";
}

/** Derive a per-project Milvus collection name via the shared script. */
function deriveCollectionName(projectDir) {
  try {
    return execSync(`bash "${join(COPILOT_SCRIPTS, "derive-collection.sh")}" "${projectDir}"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "ms_copilot_default";
  }
}

/** Shell-escape a string for safe use inside single quotes. */
function shellEscape(s) {
  return s.replace(/'/g, "'\\''");
}

/**
 * Run a Codex hook script, optionally piping a JSON payload on stdin.
 * Returns the parsed JSON output object (or {} on failure).
 * session-start.sh discards stdin itself via `exec < /dev/null`.
 */
function runHook(script, stdinPayload, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = exec(
      `bash "${script}"`,
      {
        timeout: 35000,
        env: {
          ...process.env,
          // Skip stdin read in common.sh when we have no payload to send
          ...(stdinPayload ? {} : { MEMSEARCH_SKIP_HOOK_STDIN: "1" }),
          ...extraEnv,
        },
      },
      (_err, stdout) => {
        if (_err) session.log?.(`[memsearch] hook error: ${script}: ${_err.message}`, { ephemeral: true });
        try { resolve(JSON.parse(stdout || "{}")); } catch { resolve({}); }
      }
    );
    if (stdinPayload) {
      child.stdin.write(typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload));
    }
    child.stdin.end();
  });
}

/**
 * Write a minimal Codex-format JSONL rollout file from one user+assistant turn.
 * stop.sh + parse-rollout.sh use this format for LLM summarization.
 * stop.sh parses the file synchronously before going async, so it's safe
 * to delete after stop.sh exits.
 */
function writeRollout(userMsg, assistantMsg) {
  const path = join(tmpdir(), `memsearch-copilot-${Date.now()}.jsonl`);
  // stop.sh exits early when wc -l < 3 — envelope events ensure the count is always >= 4.
  // parse-rollout.sh uses task_started to find turn boundaries.
  const lines = [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
  ];
  if (userMsg) {
    lines.push(JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: userMsg } }));
  }
  if (assistantMsg) {
    lines.push(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: assistantMsg } }));
  }
  lines.push(JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────────────────────

const memsearchCmd = detectMemsearchCmd();

let sessionId = "";
let projectDir = process.cwd();
let collectionName = "ms_copilot_default";
let projectPinned = false;

// Per-turn tracking for stop.sh (mirrors Codex's Stop hook per-turn model)
let currentUserMsg = "";
let currentAssistantMsg = "";

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

const session = await joinSession({
  hooks: {
    onSessionStart: async (input, invocation) => {
      // invocation may be undefined depending on SDK version — guard defensively
      sessionId = invocation?.sessionId ?? "";

      // Pin project dir at session start — never re-resolved mid-session
      if (!projectPinned) {
        projectDir = input.cwd ?? process.cwd();
        projectPinned = true;
        collectionName = deriveCollectionName(projectDir);
      }

      // Seed the per-turn buffer with the initial prompt so session.idle
      // captures it even if the user.message event fires before our listener.
      if (input.initialPrompt) {
        currentUserMsg = input.initialPrompt.trim();
      }

      // Delegate to session-start.sh — handles watch, index, memory injection
      const out = await runHook(
        join(CODEX_HOOKS, "session-start.sh"),
        null,
        { MEMSEARCH_PROJECT_DIR: projectDir }
      );

      // Map Codex hook output fields → Copilot CLI's additionalContext
      const parts = [
        out.systemMessage,
        out.hookSpecificOutput?.additionalContext,
      ].filter(Boolean);
      return parts.length ? { additionalContext: parts.join("\n\n") } : undefined;
    },

    onUserPromptSubmitted: async (input) => {
      const prompt = String(input.prompt ?? "");
      if (prompt.length < 10) return undefined;
      currentUserMsg = prompt;
      currentAssistantMsg = ""; // reset for this new turn

      // Delegate to user-prompt-submit.sh — injects "[memsearch] Memory available"
      const out = await runHook(
        join(CODEX_HOOKS, "user-prompt-submit.sh"),
        { prompt },
        { MEMSEARCH_PROJECT_DIR: projectDir }
      );
      const msg = out.systemMessage ?? "";
      return msg ? { systemPrompt: msg } : undefined;
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
          query: { type: "string", description: "Search query — describe what you want to find" },
          top_k: { type: "number", description: "Number of results to return (default: 5)" },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const topK = args.top_k ?? 5;
        return new Promise((resolve) => {
          exec(
            `${memsearchCmd} search '${shellEscape(args.query)}' --top-k ${topK} --json-output --collection ${collectionName}`,
            { timeout: 30000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
            (_err, stdout, stderr) => resolve(stdout || stderr || "No results found.")
          );
        });
      },
    },
    {
      name: "memsearch_expand",
      description:
        "Expand a memory chunk to see the full markdown section with surrounding context. " +
        "Use after memsearch_search to get details about a specific result.",
      parameters: {
        type: "object",
        properties: {
          chunk_hash: { type: "string", description: "The chunk_hash from a search result to expand" },
        },
        required: ["chunk_hash"],
      },
      handler: async (args) => {
        return new Promise((resolve) => {
          exec(
            `${memsearchCmd} expand '${shellEscape(args.chunk_hash)}' --collection ${collectionName}`,
            { timeout: 15000, env: { ...process.env, MEMSEARCH_NO_WATCH: "1" } },
            (_err, stdout, stderr) => resolve(stdout || stderr || "No content found.")
          );
        });
      },
    },
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-turn capture: mirrors Codex's Stop hook
// ─────────────────────────────────────────────────────────────────────────────

// Track the current turn's user message (skip subagent/programmatic sends)
session.on("user.message", (event) => {
  const source = event.data?.source;
  if (source && source !== "user") return;
  const content = String(event.data?.content ?? "").trim();
  if (content) {
    currentUserMsg = content;
    currentAssistantMsg = "";
  }
});

// Track the current turn's assistant response (skip sub-agent messages)
session.on("assistant.message", (event) => {
  if (event.data?.agentId) return;
  const content = String(event.data?.content ?? "").trim();
  if (content) currentAssistantMsg = content;
});

// session.idle fires when the agent finishes a turn — equivalent to Codex's Stop hook.
// Write a temp rollout file and delegate to stop.sh for LLM summarization + memory save.
session.on("session.idle", () => {
  if (!currentUserMsg && !currentAssistantMsg) return;

  const rolloutPath = writeRollout(currentUserMsg, currentAssistantMsg);
  const payload = JSON.stringify({
    transcript_path: rolloutPath,
    session_id: sessionId,
    last_assistant_message: currentAssistantMsg,
    stop_hook_active: false,
  });

  const child = exec(
    `bash "${join(CODEX_HOOKS, "stop.sh")}"`,
    {
      timeout: 35000,
      env: { ...process.env, MEMSEARCH_PROJECT_DIR: projectDir },
    },
    () => {
      // stop.sh parses the rollout synchronously before spawning its async worker,
      // so the file is safe to delete once the hook process exits.
      try { unlinkSync(rolloutPath); } catch { /* ignore */ }
    }
  );
  child.stdin.write(payload);
  child.stdin.end();
  child.unref(); // don't block the event loop on the stop.sh worker

  // Reset for next turn
  currentUserMsg = "";
  currentAssistantMsg = "";
});
