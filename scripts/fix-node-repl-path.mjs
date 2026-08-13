#!/usr/bin/env node
/**
 * Self-heal the node_repl MCP path in ~/.grok/config.toml.
 *
 * WHY THIS EXISTS
 * ---------------
 * node_repl is Codex's binary, and Codex installs it under a CONTENT-HASHED
 * runtime directory:
 *   %LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\bin\node_repl.exe
 * Every Codex runtime update mints a NEW hash and removes the old directory,
 * which silently invalidates the absolute path pinned in Grok's config. Grok
 * then drops the server on every session with no obvious signal - the tools
 * just aren't there. Observed three times in three weeks (03b1cdac ->
 * fb8898c0 -> f1bf3cd3 -> 23828fd3), each time re-pinned by hand.
 *
 * So: re-point it automatically at launch. We only ever rewrite the path when
 * the configured one is GONE and exactly one healthy replacement exists -
 * never on ambiguity, and never touching anything but these two values.
 *
 * Exit 0 always (best-effort; a launcher step must not block the app).
 * Prints a line only when it actually changes something.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG = path.join(os.homedir(), ".grok", "config.toml");
const RUNTIMES = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "OpenAI",
  "Codex",
  "runtimes",
  "cua_node"
);

function main() {
  if (!fs.existsSync(CONFIG)) return;

  const original = fs.readFileSync(CONFIG, "utf8");

  // Pull the currently configured command path out of [mcp_servers.node_repl].
  const cmdRe = /(\[mcp_servers\.node_repl\]\s*\ncommand\s*=\s*')([^']*)(')/;
  const m = original.match(cmdRe);
  if (!m) return; // node_repl not configured at all - nothing to heal
  const configured = m[2];

  if (configured && fs.existsSync(configured)) return; // still valid

  // Find healthy candidates: a runtime dir that actually has the binary.
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(RUNTIMES, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(RUNTIMES, e.name, "bin", "node_repl.exe"))
      .filter((p) => fs.existsSync(p));
  } catch {
    return; // Codex not installed here - leave the config alone
  }

  // Refuse to guess. Zero means Codex is gone; more than one means we cannot
  // tell which runtime the user wants, and picking wrong is worse than a
  // missing server the user can see in `grok mcp doctor`.
  if (candidates.length !== 1) {
    if (candidates.length === 0) {
      console.error(
        `[fix-node-repl-path] configured node_repl is missing and no replacement found under ${RUNTIMES} - leaving config untouched`
      );
    } else {
      console.error(
        `[fix-node-repl-path] configured node_repl is missing but ${candidates.length} candidates exist - ambiguous, leaving config untouched`
      );
    }
    return;
  }

  const exe = candidates[0];
  const mods = path.join(path.dirname(exe), "node_modules");

  let next = original.replace(cmdRe, (_all, pre, _old, post) => pre + exe + post);
  // The env var must move with it or the server starts but resolves no modules.
  next = next.replace(
    /(NODE_REPL_NODE_MODULE_DIRS\s*=\s*')([^']*)(')/,
    (_all, pre, _old, post) => pre + mods + post
  );

  if (next === original) return;

  fs.copyFileSync(CONFIG, `${CONFIG}.bak-nodereplpath`);
  fs.writeFileSync(CONFIG, next);
  console.error(
    `[fix-node-repl-path] node_repl path was stale (${configured || "empty"}) -> re-pinned to ${exe}`
  );
}

try {
  main();
} catch (e) {
  console.error(`[fix-node-repl-path] skipped: ${e.message}`);
}
