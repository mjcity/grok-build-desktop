/**
 * Grok Gateway v2 — Hermes Desktop–compatible backend for the Grok CLI.
 *
 * Speaks the exact HTTP + WS contracts of the real Hermes backend
 * (hermes_cli/web_server.py + tui_gateway/server.py at commit 4281151),
 * backed by grok.exe headless turns with --resume continuity.
 *
 * Contract rules that keep the Hermes renderer alive (verified against
 * apps/desktop/src at the same commit):
 *  - A 200 with the wrong JSON shape crashes the UI; a 4xx/5xx is caught
 *    almost everywhere. Unknown /api/* therefore 404s with {"detail": ...}
 *    exactly like the real FastAPI server — never a fake 200.
 *  - /api/profiles MUST be {profiles:[...]}, /api/providers/oauth MUST be
 *    {providers:[...]}, /api/profiles/sessions MUST have a sessions array
 *    (boot gate), /api/cron/jobs MUST be a bare top-level array.
 *  - session.info payloads MUST carry desktop_contract >= 2 or the desktop
 *    refuses to drive the session.
 *  - Session/message timestamps are epoch SECONDS (floats); cron would be
 *    ISO strings.
 *  - WS events use {method:"event", params:{type, session_id, payload}};
 *    message.start has no payload; message.complete carries the FULL text
 *    plus usage + status; prompt.submit acks {status:"streaming"|"queued"}.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GROK_GATEWAY_PORT || 8787);
const HOST = process.env.GROK_GATEWAY_HOST || "127.0.0.1";
const TOKEN = process.env.GROK_GATEWAY_TOKEN || "local-grok-dev-token";
const DATA =
  process.env.GROK_GATEWAY_HOME ||
  path.join(os.homedir(), ".grok-hermes-desktop");
const LOGS = path.join(DATA, "logs");
const MODEL = process.env.GROK_GATEWAY_MODEL || "grok-4.6";
const REASONING_EFFORT =
  process.env.GROK_GATEWAY_REASONING_EFFORT || "medium";
const PROVIDER = "grok-cli";
const VERSION = "1.4.2"; // mirrors the Hermes build the desktop shipped with
const RELEASE_DATE = "2026-07-01";
const DEFAULT_CWD = resolveDefaultCwd();

fs.mkdirSync(LOGS, { recursive: true });
const STORE = path.join(DATA, "sessions.json");

// ── logging ───────────────────────────────────────────────────────────────

const APP_LOG = path.join(LOGS, "gateway.log");
const HTTP_LOG = path.join(LOGS, "gateway-http.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotate(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* best-effort */
  }
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  rotate(APP_LOG);
  try {
    fs.appendFileSync(APP_LOG, line);
  } catch {
    /* ignore */
  }
  process.stdout.write(line);
}

function shapeOf(body) {
  if (Array.isArray(body)) return `array[${body.length}]`;
  if (body && typeof body === "object")
    return `{${Object.keys(body).slice(0, 8).join(",")}}`;
  return typeof body;
}

function httpLog(req, status, body, ms) {
  rotate(HTTP_LOG);
  const line = `${new Date().toISOString()} ${req.method} ${req.url} -> ${status} ${shapeOf(body)} ${ms}ms\n`;
  try {
    fs.appendFileSync(HTTP_LOG, line);
  } catch {
    /* ignore */
  }
}

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT ${err.stack || err.message}`);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED_REJECTION ${err?.stack || err}`);
});

// ── grok CLI ──────────────────────────────────────────────────────────────

function resolveDefaultCwd() {
  if (
    process.env.GROK_GATEWAY_CWD &&
    fs.existsSync(process.env.GROK_GATEWAY_CWD)
  ) {
    return process.env.GROK_GATEWAY_CWD;
  }
  if (fs.existsSync("D:\\Program\\grok")) return "D:\\Program\\grok";
  return process.cwd();
}

function findGrok() {
  for (const c of [
    process.env.GROK_PATH,
    path.join(os.homedir(), ".grok", "bin", "grok.exe"),
    path.join(os.homedir(), ".grok", "bin", "grok"),
    path.join(os.homedir(), ".local", "bin", "grok.exe"),
  ]) {
    if (c && fs.existsSync(c)) return c;
  }
  return "grok";
}

// ── Multi-account weekly-balance fallback ─────────────────────────────────
// A Grok CLI login lives in a per-home auth.json; GROK_HOME overrides the
// whole config dir (~/.grok). A second SuperGrok subscription with its own
// weekly "Grok Build usage balance" lives in a second home (~/.grok-b). When
// the active account's weekly balance is spent, grok.exe emits
//   {"type":"error","message":"...API error (status 402 Payment Required):
//    Grok Build usage balance exhausted..."}
// (captured live 2026-07-24) — a clean, specific signal. On that, we mark the
// account exhausted, switch the SAME turn to the next logged-in account's
// home, and retry transparently. Sticky: once marked, we route straight to
// the next account (no wasted per-turn re-probe of the dead one). The marker
// auto-expires after ACCOUNT_RESET_WINDOW_MS so the primary returns after its
// weekly reset, and a gateway restart clears markers (in-memory only) for a
// free re-probe — a 402 costs nothing since the balance is already spent.
const EXHAUSTION_RE = /402|payment required|usage balance exhausted|balance exhausted/i;
const ACCOUNT_RESET_WINDOW_MS = Number(
  process.env.GROK_ACCOUNT_RESET_WINDOW_MS || 6.5 * 24 * 60 * 60 * 1000
);
const ALL_EXHAUSTED_NOTE =
  "⚠️ All linked Grok accounts are out of weekly Grok Build balance. " +
  "The balance resets weekly — try again later, or log in another account " +
  "(GROK_HOME=~/.grok-c grok login) to add more fallback capacity.";
/** { homePath: epochMs } — in-memory only; cleared on gateway restart. */
const exhaustedAt = new Map();

function loadAccounts() {
  // Priority order. Env override: GROK_ACCOUNT_HOMES = "C:\a;C:\b".
  const raw = String(process.env.GROK_ACCOUNT_HOMES || "").trim();
  const homes = raw
    ? raw.split(path.delimiter).filter(Boolean)
    : [path.join(os.homedir(), ".grok"), path.join(os.homedir(), ".grok-b")];
  // Only homes that are actually LOGGED IN (auth.json present) can serve a
  // turn — a home without it isn't usable fallback, so skip it silently
  // rather than spawn a doomed grok on it.
  return homes
    .map((home, i) => ({ home, label: String.fromCharCode(65 + i) }))
    .filter((a) => {
      try {
        return fs.existsSync(path.join(a.home, "auth.json"));
      } catch {
        return false;
      }
    });
}

function accountUsable(a, now) {
  const ex = exhaustedAt.get(a.home);
  return !ex || now - ex > ACCOUNT_RESET_WINDOW_MS;
}

function activeAccount() {
  const now = Date.now();
  return loadAccounts().find((a) => accountUsable(a, now)) || null;
}

function nextAccountAfter(home) {
  const accounts = loadAccounts();
  const now = Date.now();
  const start = accounts.findIndex((a) => a.home === home) + 1;
  for (let i = start; i < accounts.length; i++) {
    if (accountUsable(accounts[i], now)) return accounts[i];
  }
  return null;
}

function markExhausted(home) {
  exhaustedAt.set(home, Date.now());
  log(`account exhausted (402): ${home}`);
}

function childEnv(accountHome) {
  const defaultHome = path.join(os.homedir(), ".grok");
  const home =
    accountHome || (activeAccount() && activeAccount().home) || defaultHome;
  const env = {
    ...process.env,
    GROK_DISABLE_AUTOUPDATER: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  // Only override GROK_HOME for a NON-default account, so primary-account
  // turns run byte-identically to the pre-fallback behavior (grok already
  // defaults to ~/.grok). The grok.exe BINARY is shared (lives in ~/.grok/bin,
  // found via PATH below); only the config home changes per account, so the
  // second account never needs its own binary.
  if (path.resolve(home) !== path.resolve(defaultHome)) {
    env.GROK_HOME = home;
  }
  const extras = [
    path.join(os.homedir(), ".grok", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ];
  const parts = String(env.PATH || env.Path || "").split(path.delimiter);
  for (const e of extras) if (e && !parts.includes(e)) parts.unshift(e);
  env.PATH = parts.join(path.delimiter);
  env.Path = env.PATH;
  return env;
}

// ── persistence ───────────────────────────────────────────────────────────
// In-memory cache + debounced flush. Every getSession used to read+parse the
// whole sessions.json synchronously; during long turns Hermes polls hard and
// that blocked the event loop → accept queue filled → ECONNREFUSED in the UI.

function nowSec() {
  return Date.now() / 1000;
}

/**
 * Stall detection, not a flat turn-duration cap. A real claudeloop turn can
 * legitimately run 10+ minutes with continuous tool activity — a fixed
 * wall-clock timeout would kill good turns. What actually happened once
 * (2026-07-20): grok.exe opened a TCP connection to its model backend and
 * then produced ZERO output — no text, no thought, no tool event — for 8+
 * minutes straight (confirmed via CPU time not advancing at all), leaving
 * Hermes showing "running" forever with no recovery. So: watch for TRUE
 * silence via `turnActivityAt`, touched ONLY by touchActivity() at genuine
 * progress signals (message.delta, reasoning.delta, tool.start/complete,
 * turn start) — not elapsed time, and NOT by generic emit() (a real bug,
 * found 2026-07-20: emit() used to touch it unconditionally, so the
 * keepalive's own synthetic session.info re-announcement every ~16-20s
 * perpetually fed the very clock meant to detect its absence, defeating
 * this watchdog for any turn long enough to trigger the keepalive — see the
 * comment on emit() for the full story). ABSOLUTE_TIMEOUT_MS is only a
 * last-resort backstop against a pathological loop that's "active" but
 * never finishing.
 */
// Raised 3min -> 15min (2026-07-22, session 1754d813 incident). The stall
// watchdog only recognizes `text`/`thought`/`end`/`error` stdout events as
// activity (see the proc.stdout handler below) — it has NO visibility into a
// single tool call that is legitimately still running. Grok's own
// get_command_or_subagent_output can correctly block for minutes waiting on
// a shared resource (e.g. claudeloop's single-writer TMM gate, documented at
// up to ~12min under multi-agent contention) with zero stdout output the
// whole time. At 3min, the watchdog killed that turn — and every identical
// retry — 6 times in a row over an hour, including across a full app
// restart (supervisor.mjs keeps this gateway alive independent of the
// Electron window, so a restart just reconnects to the same doomed retry).
// 15min comfortably clears that known worst case with margin. A genuinely
// dead turn still recovers, just slower to detect.
const STALL_TIMEOUT_MS = Number(
  process.env.GROK_STALL_TIMEOUT_MS || 15 * 60 * 1000
);
const ABSOLUTE_TIMEOUT_MS = Number(
  process.env.GROK_ABSOLUTE_TIMEOUT_MS || 45 * 60 * 1000
);
const WATCHDOG_INTERVAL_MS = 15_000;

function formatDuration(ms) {
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.round(ms / 60_000)} min`;
}

/**
 * Self-improvement, ported from Hermes's fork-and-review to Grok's own
 * native primitives instead of reinventing them:
 *
 * Tier 1 (free): --experimental-memory turns on Grok's built-in cross-session
 * memory (~/.grok/memory) — automatic zero-cost session-end summaries,
 * first-turn recall injection, and "remember/forget/what do you remember"
 * working in any turn. No gateway logic needed; the flag is the feature.
 *
 * Tier 2 (has a real recurring cost — gated, not blanket): Hermes forks an
 * agent after EVERY turn to judge "should anything be saved?" (real API
 * call, every turn). Grok's rich equivalent (/flush) is TUI-only, so we
 * replicate it ourselves — but only after DIFFICULT tasks, using signals
 * Grok's own `end` event already reports (no heuristic-guessing needed):
 * num_turns (internal tool round-trips) and our own tool-feed's call count.
 * A trivial "hi" is num_turns=1; a real multi-step task easily hits 4+.
 */
const REFLECT_ENABLED = process.env.GROK_REFLECT_ENABLED !== "0";
const REFLECT_MIN_NUM_TURNS = Number(
  process.env.GROK_REFLECT_MIN_NUM_TURNS || 4
);
const REFLECT_MIN_TOOL_CALLS = Number(
  process.env.GROK_REFLECT_MIN_TOOL_CALLS || 3
);
const REFLECT_MIN_REASONING_TOKENS = Number(
  process.env.GROK_REFLECT_MIN_REASONING_TOKENS || 3000
);
const REFLECT_PROMPT =
  "Reflect on the task you just completed in this session. If you learned " +
  "a durable project fact, a user preference, a workflow correction, or a " +
  "reusable multi-step procedure worth turning into a skill, save it now " +
  "using your memory tools (and your create-skill skill, if a genuinely " +
  "reusable procedure emerged). Be conservative — only save things with " +
  "lasting value, not one-off details specific to this single request. If " +
  "nothing durable emerged, do not save anything and reply with exactly: " +
  "NOTHING_TO_SAVE";

let storeCache = null;
let storeDirty = false;
let saveTimer = null;

/**
 * Placeholder for a VISIBLE turn that produced no text at all (Stop pressed
 * before the first token, spawn died silently, etc.).
 *
 * Why this exists (2026-07-25, sessions 1754d813 + 2da8d11e): persisting an
 * assistant message with content:"" permanently wedges that thread in Hermes
 * Desktop. An empty bubble is not a visible message, so the thread's last
 * VISIBLE message stays the user's (lastVisibleMessageIsUser -> true) and the
 * view keeps treating the turn as still in flight — the composer never frees
 * up, so new prompts never even reach this gateway (confirmed: zero
 * `turn start` AND zero `busy reject` lines for a session the user was
 * actively retrying). It survives app restarts because the empty message is
 * on disk, which is why "stop the process and resend" never helped. Sessions
 * with empty assistant messages MID-history were unaffected — only a trailing
 * one wedges. Always terminate a visible turn with real text.
 */
const EMPTY_TURN_NOTE = "⏹️ Stopped — this turn ended before any output was produced.";

function loadStore() {
  if (storeCache) return storeCache;
  try {
    storeCache = JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    storeCache = { sessions: [] };
  }
  if (!Array.isArray(storeCache.sessions)) storeCache.sessions = [];
  // Self-heal records poisoned by older builds, so an already-frozen thread
  // comes back to life on the next gateway start instead of staying dead
  // forever. Only the TRAILING message is touched — history is never rewritten.
  let repaired = 0;
  for (const s of storeCache.sessions) {
    const msgs = Array.isArray(s?.messages) ? s.messages : null;
    if (!msgs || !msgs.length) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && !String(last.content || "").trim()) {
      last.content = EMPTY_TURN_NOTE;
      repaired += 1;
    }
  }
  if (repaired) {
    storeDirty = true;
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flushStore();
      }, 40);
    }
    log(`unwedged ${repaired} session(s) with a trailing empty assistant message`);
  }
  return storeCache;
}

function flushStore() {
  if (!storeDirty || !storeCache) return;
  storeDirty = false;
  try {
    const tmp = STORE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(storeCache, null, 2), "utf8");
    // On Windows rename-over can EPERM if another handle is open; retry once.
    try {
      fs.renameSync(tmp, STORE);
    } catch {
      try {
        fs.copyFileSync(tmp, STORE);
        fs.unlinkSync(tmp);
      } catch (e2) {
        storeDirty = true;
        log(`saveStore rename/copy failed: ${e2.message}`);
      }
    }
  } catch (e) {
    storeDirty = true;
    log(`saveStore failed: ${e.message}`);
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flushStore();
      }, 250);
    }
  }
}

function saveStore(data) {
  storeCache = data;
  storeDirty = true;
  if (saveTimer) return;
  // Coalesce rapid writes (prompt start + message complete + title) into one.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushStore();
  }, 40);
}

function forceKillPidTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

process.on("beforeExit", () => flushStore());
process.on("exit", () => {
  if (storeDirty && storeCache) {
    try {
      fs.writeFileSync(STORE, JSON.stringify(storeCache, null, 2), "utf8");
    } catch {
      /* best effort */
    }
  }
});

function getSession(id) {
  if (!id) return null;
  const data = loadStore();
  return (
    data.sessions.find((s) => s.id === id) ||
    data.sessions.find((s) => s.id.startsWith(id)) ||
    null
  );
}

function upsertSession(session) {
  const data = loadStore();
  const i = data.sessions.findIndex((s) => s.id === session.id);
  if (i >= 0) data.sessions[i] = session;
  else data.sessions.unshift(session);
  saveStore(data);
  return session;
}

function createSession(partial = {}) {
  const t = nowSec();
  const session = {
    id: partial.id || randomUUID(),
    title: partial.title || "",
    cwd: partial.cwd || DEFAULT_CWD,
    model: partial.model || MODEL,
    grok_session_id: null,
    messages: [],
    created_at: t,
    updated_at: t,
    archived: false,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    api_call_count: 0,
    estimated_cost_usd: 0,
  };
  return upsertSession(session);
}

// ── canonical shapes ──────────────────────────────────────────────────────

/** SessionInfo row for list endpoints (hermes_state list_sessions_rich). */
function sessionRow(s, withProfile) {
  const msgs = s.messages || [];
  const firstUser = msgs.find((m) => m.role === "user");
  const row = {
    id: s.id,
    source: "desktop",
    user_id: null,
    session_key: null,
    chat_id: null,
    chat_type: null,
    thread_id: null,
    display_name: null,
    origin_json: null,
    expiry_finalized: 0,
    model: s.model || MODEL,
    parent_session_id: null,
    started_at: s.created_at,
    ended_at: null,
    end_reason: null,
    message_count: msgs.length,
    tool_call_count: 0,
    input_tokens: s.input_tokens || 0,
    output_tokens: s.output_tokens || 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: s.reasoning_tokens || 0,
    cwd: s.cwd || DEFAULT_CWD,
    git_branch: null,
    git_repo_root: null,
    billing_provider: null,
    billing_base_url: null,
    billing_mode: null,
    estimated_cost_usd: s.estimated_cost_usd || 0,
    actual_cost_usd: null,
    cost_status: null,
    cost_source: null,
    pricing_version: null,
    title: s.title || null,
    api_call_count: s.api_call_count || 0,
    handoff_state: null,
    handoff_platform: null,
    handoff_error: null,
    compression_failure_cooldown_until: null,
    compression_failure_error: null,
    rewind_count: 0,
    archived: !!s.archived,
    preview: firstUser ? String(firstUser.content || "").slice(0, 60) : null,
    last_active: s.updated_at,
    is_active: activeTurns.has(s.id),
    _lineage_root_id: null,
  };
  if (withProfile) {
    row.profile = "default";
    row.is_default_profile = true;
  }
  return row;
}

function sessionUsage(s) {
  const input = s.input_tokens || 0;
  const output = s.output_tokens || 0;
  return {
    model: s.model || MODEL,
    input,
    output,
    reasoning: s.reasoning_tokens || 0,
    prompt: input,
    completion: output,
    total: input + output,
    calls: s.api_call_count || 0,
    context_used: null,
    context_max: 256000,
    context_percent: null,
  };
}

/**
 * session.info EVENT payload (mirrors tui_gateway's _session_info).
 *
 * desktop_contract history (upstream apps/desktop/src/store/updates.ts):
 *   v2 file.attach RPC · v3 approvals.mode RPCs + info reconciliation
 *   v4 explicit Fast-off session creation + session-scoped Fast edits
 *   v5 raised WebSocket frame size for large one-shot file.attach
 *
 * We declare 5 (verified against upstream 40e0e7ad, 2026-08-01). Field-shape
 * parity was checked key-by-key: we already send every v5 top-level field
 * (plus two harmless extras the renderer ignores, mcp_servers/system_prompt).
 * The v5 frame-size requirement is satisfied by default — our WebSocketServer
 * sets no maxPayload, so it uses ws's ~100MB default, far above the raised
 * bar. Honest caveat: we don't implement the file.attach RPC itself (this
 * gateway drives the Grok CLI rather than Hermes's own file staging), so
 * explicitly attaching a file in the composer is unsupported here — that is
 * pre-existing and unrelated to the contract number. Everything the contract
 * check actually gates (session.info shape on every session open) is met, so
 * declaring 4 only produced a false "backend out of date" toast.
 */
function sessionInfoPayload(s, running) {
  return {
    model: s.model || MODEL,
    provider: PROVIDER,
    reasoning_effort: REASONING_EFFORT,
    service_tier: "",
    fast: false,
    yolo: true, // grok runs with --always-approve
    approval_mode: "off", // consistent with yolo:true (upstream: yolo ||= mode=="off")
    tools: {},
    skills: {},
    cwd: s.cwd || DEFAULT_CWD,
    branch: null,
    project: null, // real backend returns null when cwd is not a first-class Project
    personality: "",
    running: !!running,
    title: s.title || "",
    stored_session_id: s.id,
    // Contract 6 (upstream 2026-08-13). Each level is a capability assertion,
    // so this is only bumped after checking what the level actually demands —
    // never as a cosmetic way to silence the skew toast:
    //   v2 file.attach RPC · v3 approvals.mode RPCs · v4 explicit Fast-off
    //   session creation · v5 raised WS frame size for one-shot file.attach
    //   v6 key-addressed plugins.manage rows (keyless rows render read-only)
    // v6 is vacuously satisfied here: we don't implement plugins.manage at all
    // (Grok owns its plugins via ~/.grok/config.toml), so the RPC returns a
    // clean JSON-RPC -32601 and Settings → Plugins gets ZERO rows. With no
    // rows there are no keyless rows to mis-render, which is the only thing
    // v6 guards. v2/v3/v5 concern file.attach + approvals RPCs we likewise
    // don't serve; v4's session-creation shape we already honor.
    desktop_contract: 6,
    // Added upstream 2026-08 (arrived under contract 5 — additive, renderer type-guards
    // it). NOT cosmetic: the desktop keys attachment handling off this. Any of
    // CONTAINER_TERMINAL_BACKENDS (docker/ssh/singularity/modal/daytona/
    // vercel_sandbox) makes it upload dropped files, because the backend can't
    // see host paths. We spawn grok.exe locally, sharing Electron's filesystem,
    // so "local" is the honest answer and host paths pass through untouched.
    terminal_backend: "local",
    version: VERSION,
    release_date: RELEASE_DATE,
    update_behind: 0,
    update_command: null,
    usage: sessionUsage(s),
    profile_name: "default",
    mcp_servers: [],
    system_prompt: "",
  };
}

/** WS display messages (_history_to_messages: role + text). */
function displayMessages(s) {
  return (s.messages || []).map((m) => ({
    role: m.role,
    text: m.content || "",
    content: m.content || "",
  }));
}

/** REST message rows (/api/sessions/{id}/messages). */
function restMessages(s) {
  return (s.messages || []).map((m, i) => ({
    id: i + 1,
    session_id: s.id,
    role: m.role,
    content: m.content ?? null,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    effect_disposition: null,
    timestamp: m.timestamp,
    token_count: null,
    finish_reason: null,
    reasoning: m.reasoning ?? null,
    reasoning_content: null,
    reasoning_details: null,
    codex_reasoning_items: null,
    codex_message_items: null,
    platform_message_id: null,
    observed: 0,
    active: 1,
    compacted: 0,
  }));
}

function filterSessions(params) {
  const data = loadStore();
  let rows = data.sessions.slice();

  const archived = params.get("archived") || "exclude";
  if (archived === "exclude") rows = rows.filter((s) => !s.archived);
  else if (archived === "only") rows = rows.filter((s) => s.archived);

  const minMessages = Number(params.get("min_messages") || 0);
  if (minMessages > 0)
    rows = rows.filter((s) => (s.messages || []).length >= minMessages);

  // All our sessions are source:"desktop".
  const source = params.get("source");
  if (source && source !== "desktop") rows = [];
  const exclude = (params.get("exclude_sources") || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (exclude.includes("desktop")) rows = [];

  const order = params.get("order") || "recent";
  rows.sort((a, b) =>
    order === "created"
      ? (b.created_at || 0) - (a.created_at || 0)
      : (b.updated_at || 0) - (a.updated_at || 0)
  );

  const limit = Math.max(1, Number(params.get("limit") || 20));
  const offset = Math.max(0, Number(params.get("offset") || 0));
  return { rows, page: rows.slice(offset, offset + limit), limit, offset };
}

// ── WS broadcast ──────────────────────────────────────────────────────────

/** @type {Set<import('ws').WebSocket>} */
const sockets = new Set();
/** @type {Map<string, { cancel: () => void }>} */
const activeTurns = new Map();
/** @type {Map<string, string[]>} */
const queuedPrompts = new Map();
/** Last activity timestamp per session (for quiet-period busy re-assert). */
const turnActivityAt = new Map();
/** Keepalive timers while a turn is running. */
const turnKeepalives = new Map();

// How to handle prompt.submit while a turn is already running.
//   reject    (default) — 4009 "session busy". Hermes Desktop keeps its own
//              composer queue + auto-drain; a silent {status:"queued"} success
//              is treated as a started turn and freezes the feed (no deltas).
//   queue     — accept {status:"queued"}, drain after current turn (API clients).
//   interrupt — cancel live turn then queue (native Hermes default policy).
const BUSY_MODE = String(
  process.env.GROK_GATEWAY_BUSY_MODE || "reject"
).toLowerCase();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function emit(sessionId, type, payload) {
  const params = { type, session_id: sessionId };
  if (payload !== undefined) params.payload = payload;
  const raw = JSON.stringify({ jsonrpc: "2.0", method: "event", params });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(raw);
  }
  // NOTE: deliberately does NOT touch turnActivityAt anymore. It used to,
  // and that was a real bug (found 2026-07-20 on a live stuck session):
  // startTurnKeepalive re-emits a synthetic session.info every ~8-16s so the
  // UI doesn't look frozen during a quiet tool loop — but since THAT emit()
  // call also refreshed the stall watchdog's activity clock, a genuinely
  // dead grok.exe (zero real output, forever) still looked "recently active"
  // every ~16s forever, because our OWN keepalive kept feeding the watchdog
  // it was supposed to be independent of. With the 3-minute default
  // STALL_TIMEOUT_MS, the keepalive (every ~16-20s) always won the race, so
  // the watchdog could never fire in production — confirmed by a session
  // that sat "busy" for 45+ minutes with no recovery. An 8-second test
  // timeout in stall-e2e.mjs happened to be SHORTER than the keepalive's own
  // cycle, which is exactly why that test passed despite the bug.
  // Fix: only genuine progress touches the clock now, via touchActivity()
  // called explicitly at the real signal sites (message.delta,
  // reasoning.delta, tool.start, tool.complete, turn start) — never from a
  // synthetic/bookkeeping emit like the keepalive's own re-announcement.
}

function touchActivity(sessionId) {
  if (sessionId) turnActivityAt.set(sessionId, Date.now());
}

function clearTurnKeepalive(sessionId) {
  const t = turnKeepalives.get(sessionId);
  if (t) {
    clearInterval(t);
    turnKeepalives.delete(sessionId);
  }
  turnActivityAt.delete(sessionId);
}

function startTurnKeepalive(session, sessionId) {
  clearTurnKeepalive(sessionId);
  turnActivityAt.set(sessionId, Date.now());
  // Re-assert running when quiet so the desktop does not look "stuck"
  // during long tool loops with no text/thought frames. Does not invent
  // fake reasoning spam — only session.info the UI already understands.
  const timer = setInterval(() => {
    if (!activeTurns.has(sessionId)) {
      clearTurnKeepalive(sessionId);
      return;
    }
    const last = turnActivityAt.get(sessionId) || 0;
    if (Date.now() - last < 12_000) return;
    emit(sessionId, "session.info", sessionInfoPayload(session, true));
  }, 8_000);
  turnKeepalives.set(sessionId, timer);
}

function enqueueGatewayPrompt(sessionId, text) {
  const queue = queuedPrompts.get(sessionId) || [];
  // Merge consecutive same-session arrivals (native Hermes does this) so a
  // double-fire from UI+gateway does not create phantom extra turns.
  if (queue.length && queue[queue.length - 1] === text) {
    return queue.length;
  }
  queue.push(text);
  queuedPrompts.set(sessionId, queue);
  return queue.length;
}

function scheduleQueueDrain(session) {
  // Defer so the client processes message.complete + running:false first.
  // Immediate submitPrompt in the same tick races Hermes auto-drain and
  // leaves chips stuck on "queued" while the next turn is already live.
  const sid = session.id;
  setTimeout(() => {
    if (activeTurns.has(sid)) return;
    const queue = queuedPrompts.get(sid);
    if (!queue || !queue.length) return;
    const next = queue.shift();
    if (!queue.length) queuedPrompts.delete(sid);
    else queuedPrompts.set(sid, queue);
    log(
      `queue drain session=${sid.slice(0, 8)} remaining=${queue.length} text=${JSON.stringify(String(next).slice(0, 60))}`
    );
    try {
      submitPrompt(session, next);
    } catch (e) {
      log(`queue drain failed session=${sid.slice(0, 8)}: ${e.message}`);
      emit(sid, "error", {
        message: `Queued prompt failed to start: ${e.message}`,
      });
      emit(sid, "session.info", sessionInfoPayload(session, false));
    }
  }, 75);
}

// ── Grok turn runner ──────────────────────────────────────────────────────
// Pre-feed-fix baseline: map Grok streaming-json → Hermes WS events only.
// No kickoff text, no quiet heartbeats, no stderr→reasoning.delta injection.
// (Static-feed root cause is investigated separately — see Claude/Fable prompt.)

// ── tool-activity feed ────────────────────────────────────────────────────
// grok.exe's stdout stream carries only text/thought/end — tool activity is
// invisible in it. But grok writes a live per-session event log:
//   ~/.grok/sessions/<encodeURIComponent(cwd)>/<grok_session_id>/events.jsonl
//   {"ts","type":"tool_started","tool_name":"read_file"}
//   {"ts","type":"tool_completed","tool_name":"read_file","duration_ms":46,"outcome":"success"}
// Tailing it during a turn and mapping records onto Hermes tool.start /
// tool.complete gives the desktop its native running-chip → checkmark feed
// from Grok's own data. status.update phases are NOT forwarded: the desktop
// ignores generic status kinds (gateway-event.ts only acts on
// compacting/process).

function grokSessionsRoot(cwd, accountHome) {
  // Per-account: grok writes its session event log under its OWN GROK_HOME,
  // so a fallback turn on account B tails ~/.grok-b/sessions, not ~/.grok.
  return path.join(
    accountHome || path.join(os.homedir(), ".grok"),
    "sessions",
    encodeURIComponent(cwd || DEFAULT_CWD)
  );
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function startToolFeed(session, spawnedAtMs, { silent = false, accountHome = null, resumeId = null } = {}) {
  const root = grokSessionsRoot(session.cwd || DEFAULT_CWD, accountHome);
  let eventsPath = null;
  let offset = 0;
  let carry = "";
  let counter = 0;
  let toolStartCount = 0; // difficulty signal for Tier 2 — see REFLECT_* above
  let lastDiscoverMs = 0;
  /** @type {{tool_id: string, name: string}[]} */
  const running = [];

  // Resumed session: the dir is known; skip everything already on disk.
  // Uses this account's resume id (per-account — see runGrokTurn), not the
  // generic session.grok_session_id, so a fallback turn tails the right dir.
  if (resumeId) {
    eventsPath = path.join(root, resumeId, "events.jsonl");
    offset = Math.max(0, safeSize(eventsPath));
  }

  function discover() {
    // Throttle: sessions roots grow large; readdirSync every 400ms freezes the
    // event loop and Hermes sees ECONNREFUSED mid-turn.
    const now = Date.now();
    if (now - lastDiscoverMs < 2000) return;
    lastDiscoverMs = now;
    // First turn: grok creates a new session dir at startup. Adopt the
    // newest dir born after our spawn. (Two first-turn sessions starting
    // simultaneously in the same cwd could race here — cosmetic-only risk.)
    let best = null;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return; // cwd has no session history yet; retry next tick
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name, "events.jsonl");
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.birthtimeMs >= spawnedAtMs - 3000 && (!best || st.birthtimeMs > best.t)) {
        best = { p, t: st.birthtimeMs };
      }
    }
    if (best) {
      eventsPath = best.p;
      offset = 0;
    }
  }

  function handleRecord(rec) {
    if (rec.type === "tool_started" && rec.tool_name) {
      toolStartCount++;
      touchActivity(session.id); // real progress — counts for silent reflection turns too
      if (silent) return; // background reflection — no chips for the user to see
      const tool_id = `${session.id.slice(0, 8)}-t${++counter}`;
      running.push({ tool_id, name: rec.tool_name });
      emit(session.id, "tool.start", { tool_id, name: rec.tool_name });
    } else if (rec.type === "tool_completed" && rec.tool_name) {
      touchActivity(session.id);
      if (silent) return;
      // events.jsonl has no tool ids; grok can run same-named tools in
      // parallel, so complete the oldest running chip with that name.
      const i = running.findIndex((r) => r.name === rec.tool_name);
      const r =
        i >= 0
          ? running.splice(i, 1)[0]
          : {
              tool_id: `${session.id.slice(0, 8)}-t${++counter}`,
              name: rec.tool_name,
            };
      const payload = {
        tool_id: r.tool_id,
        name: r.name,
        duration_ms: rec.duration_ms,
      };
      if (rec.outcome && rec.outcome !== "success") {
        payload.error = String(rec.outcome);
      }
      emit(session.id, "tool.complete", payload);
    }
  }

  const timer = setInterval(() => {
    try {
      if (!eventsPath) {
        discover();
        if (!eventsPath) return;
      }
      const size = safeSize(eventsPath);
      if (size < 0 || size === offset) return;
      if (size < offset) offset = 0; // truncated/rotated — re-read
      const fd = fs.openSync(eventsPath, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        carry += buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      let idx;
      while ((idx = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, idx).trim();
        carry = carry.slice(idx + 1);
        if (!line) continue;
        try {
          handleRecord(JSON.parse(line));
        } catch {
          /* partial/garbled line — skip */
        }
      }
    } catch (e) {
      // The feed is best-effort; never let it disturb a turn.
      log(`tool-feed error session=${session.id.slice(0, 8)}: ${e.message}`);
    }
  }, 400);

  return {
    stop() {
      clearInterval(timer);
      // Settle any chips still marked running so nothing spins forever —
      // one final drain first in case records landed after the last tick.
      try {
        if (eventsPath) {
          const size = safeSize(eventsPath);
          if (size > offset) {
            const fd = fs.openSync(eventsPath, "r");
            try {
              const buf = Buffer.alloc(size - offset);
              fs.readSync(fd, buf, 0, buf.length, offset);
              offset = size;
              carry += buf.toString("utf8");
            } finally {
              fs.closeSync(fd);
            }
            for (const line of carry.split("\n")) {
              const t = line.trim();
              if (!t) continue;
              try {
                handleRecord(JSON.parse(t));
              } catch {
                /* skip */
              }
            }
            carry = "";
          }
        }
      } catch {
        /* best-effort */
      }
      if (!silent) {
        for (const r of running.splice(0)) {
          emit(session.id, "tool.complete", { tool_id: r.tool_id, name: r.name });
        }
      }
    },
    get toolStartCount() {
      return toolStartCount;
    },
  };
}

function runGrokTurn(session, text, { silent = false, accountHome = null, retryCount = 0 } = {}) {
  // Resolve which account (config home) this turn runs on. accountHome is set
  // only when we're retrying after a 402 fallback; otherwise pick the active
  // one. If every logged-in account is out of weekly balance, don't spawn a
  // doomed grok — surface a clear message and settle the turn.
  const home = accountHome || (activeAccount() && activeAccount().home) || null;
  if (!home) {
    if (!silent) {
      emit(session.id, "session.info", sessionInfoPayload(session, true));
      emit(session.id, "message.start");
      emit(session.id, "message.delta", { text: ALL_EXHAUSTED_NOTE });
      session.messages.push({ role: "assistant", content: ALL_EXHAUSTED_NOTE, timestamp: nowSec() });
      session.updated_at = nowSec();
      upsertSession(session);
      emit(session.id, "message.complete", {
        text: ALL_EXHAUSTED_NOTE,
        usage: sessionUsage(session),
        status: "error",
      });
      emit(session.id, "session.info", sessionInfoPayload(session, false));
    }
    activeTurns.delete(session.id);
    return;
  }

  // Per-account grok session ids: a resume id created under account A's home
  // does NOT exist under account B's, so track one id per home. On a fallback
  // switch the new account simply starts fresh (grok's own --resume
  // continuity is per-home; the gateway keeps the full transcript itself).
  session.grok_session_ids = session.grok_session_ids || {};
  const resumeId = session.grok_session_ids[home] || null;

  const binary = findGrok();
  const argv = [
    "--output-format",
    "streaming-json",
    "--no-auto-update",
    // Tier 1 self-improvement: Grok's own cross-session memory (off by
    // default upstream). Gives automatic zero-cost session-end summaries,
    // first-turn recall injection, and working "remember/forget/what do you
    // remember" — for free, no gateway logic required. See REFLECT_* above
    // for Tier 2 (the part that DOES need gateway logic).
    "--experimental-memory",
    "-m",
    session.model || MODEL,
    "--reasoning-effort",
    REASONING_EFFORT,
    "--cwd",
    session.cwd || DEFAULT_CWD,
    "--always-approve",
  ];
  if (resumeId) argv.push("--resume", resumeId);
  argv.push("-p", text);

  let buffer = "";
  let full = "";
  let reasoning = "";
  let cancelled = false; // user pressed Stop (session.interrupt)
  let autoKillReason = null; // "stall" | "absolute" — our watchdog fired, not the user
  let sawExhaustion = false; // grok reported 402/usage-balance-exhausted — trigger account fallback
  let turnUsage = null;
  let turnNumTurns = null; // Grok's own internal tool-round-trip count — Tier 2's difficulty signal
  let finished = false;
  const turnStartedAt = Date.now();

  log(
    `turn start session=${session.id.slice(0, 8)} account=${home} resume=${resumeId || "-"}${retryCount ? ` retry=${retryCount}` : ""}${silent ? " (silent/reflection)" : ""}`
  );

  const proc = spawn(binary, argv, {
    cwd:
      session.cwd && fs.existsSync(session.cwd) ? session.cwd : DEFAULT_CWD,
    env: childEnv(home),
    windowsHide: true,
  });

  if (proc.stdout && typeof proc.stdout.setEncoding === "function") {
    proc.stdout.setEncoding("utf8");
  }
  if (proc.stderr && typeof proc.stderr.setEncoding === "function") {
    proc.stderr.setEncoding("utf8");
  }

  // Purely mechanical — callers set `cancelled` (user stop) or
  // `autoKillReason` (watchdog) themselves BEFORE calling this, so the close
  // handler can tell the two apart.
  const killTurnTree = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    if (proc.pid) forceKillPidTree(proc.pid);
  };

  // Stall watchdog: kill only on true silence (see STALL_TIMEOUT_MS comment
  // above), with a generous absolute backstop. Checked periodically rather
  // than a single timer so a turn that goes quiet-then-busy-then-quiet again
  // is judged on its most recent activity, not cumulative elapsed time.
  const watchdogTimer = setInterval(() => {
    const now = Date.now();
    const lastActivity = turnActivityAt.get(session.id) || turnStartedAt;
    if (now - turnStartedAt > ABSOLUTE_TIMEOUT_MS) {
      autoKillReason = "absolute";
    } else if (now - lastActivity > STALL_TIMEOUT_MS) {
      autoKillReason = "stall";
    } else {
      return;
    }
    log(
      `turn ${autoKillReason} session=${session.id.slice(0, 8)} elapsed=${now - turnStartedAt}ms sinceActivity=${now - lastActivity}ms`
    );
    clearInterval(watchdogTimer);
    killTurnTree();
  }, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();

  activeTurns.set(session.id, {
    cancel: () => {
      cancelled = true;
      clearInterval(watchdogTimer);
      killTurnTree();
    },
  });

  const toolFeed = startToolFeed(session, Date.now(), { silent, accountHome: home, resumeId });
  if (!silent) startTurnKeepalive(session, session.id);

  // Always open the stream lifecycle before any CLI silence so a drained
  // queue turn looks as "live" as a fresh submit. Reflection turns are
  // invisible — the user never asked for this turn and shouldn't see the
  // session flip to "running" for it.
  touchActivity(session.id); // turn genuinely just started — real signal, silent or not
  if (!silent) {
    emit(session.id, "session.info", sessionInfoPayload(session, true));
    emit(session.id, "message.start");
  }

  proc.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "text" && typeof ev.data === "string") {
        full += ev.data;
        touchActivity(session.id); // real token from grok — the actual signal that matters
        if (!silent) emit(session.id, "message.delta", { text: ev.data });
      } else if (ev.type === "thought" && typeof ev.data === "string") {
        // Grok's `thought` is real per-token chain-of-thought — Hermes's
        // reasoning.delta lane (renders in the reasoning disclosure).
        // thinking.delta would be WRONG: that lane is the kawaii spinner
        // status and the desktop hard-ignores it (gateway-event.ts:263-267).
        reasoning += ev.data;
        touchActivity(session.id);
        if (!silent) emit(session.id, "reasoning.delta", { text: ev.data });
      } else if (ev.type === "end") {
        const sid = ev.sessionId || ev.session_id;
        if (sid) {
          // Store per-account (this home's continuity) AND keep the generic
          // field synced to the account that actually ran this turn.
          session.grok_session_ids[home] = String(sid);
          session.grok_session_id = String(sid);
        }
        if (ev.usage && typeof ev.usage === "object") turnUsage = ev.usage;
        if (typeof ev.num_turns === "number") turnNumTurns = ev.num_turns;
        if (typeof ev.total_cost_usd === "number") {
          session.estimated_cost_usd =
            (session.estimated_cost_usd || 0) + ev.total_cost_usd;
        }
      } else if (ev.type === "error") {
        const msg = String(ev.message || "grok error");
        // Weekly Grok Build balance spent on this account → fall back to the
        // next account (handled in the close handler). Don't surface the raw
        // 402 to the UI; the retry (or the all-exhausted note) speaks for it.
        if (EXHAUSTION_RE.test(msg)) {
          sawExhaustion = true;
          markExhausted(home);
        } else if (!silent) {
          emit(session.id, "error", { message: msg });
        }
      }
    }
  });

  let stderr = "";
  proc.stderr.on("data", (c) => {
    stderr += typeof c === "string" ? c : c.toString("utf8");
  });

  proc.on("error", (err) => {
    log(`turn spawn error session=${session.id.slice(0, 8)}: ${err.message}`);
    finish(`Failed to start grok: ${err.message}`, "error");
  });

  proc.on("close", (code) => {
    clearInterval(watchdogTimer);

    // Account fallback: this account's weekly balance is spent. Switch the
    // SAME turn to the next logged-in account and retry, transparently — the
    // user never sees the 402. Not for silent reflection turns (optional work
    // shouldn't burn a second account's balance) and capped by account count
    // so a run of exhausted accounts can't loop.
    if (sawExhaustion && !finished) {
      const next = silent ? null : nextAccountAfter(home);
      if (next && retryCount < loadAccounts().length) {
        log(
          `account fallback session=${session.id.slice(0, 8)}: ${home} -> ${next.home} (retry ${retryCount + 1})`
        );
        toolFeed.stop();
        if (!silent) clearTurnKeepalive(session.id);
        runGrokTurn(session, text, {
          silent,
          accountHome: next.home,
          retryCount: retryCount + 1,
        });
        return; // the retried turn owns finishing; don't settle this one
      }
      // No usable account left (or a silent turn): settle cleanly. For a
      // visible turn, say so plainly instead of leaving an empty bubble.
      if (!silent) {
        full = ALL_EXHAUSTED_NOTE;
        emit(session.id, "message.delta", { text: ALL_EXHAUSTED_NOTE });
      }
      finish(full, "error");
      return;
    }

    let status = "complete";
    if (autoKillReason) {
      // Our own watchdog killed it — distinct from a user Stop and from a
      // plain non-zero exit, so the user gets an explanation instead of a
      // dead "running" chip or a silently empty bubble.
      status = "error";
      const note =
        autoKillReason === "stall"
          ? `⚠️ Grok stopped responding — no activity for ${formatDuration(STALL_TIMEOUT_MS)}, so this turn was cancelled automatically. This is usually a stalled connection to the model backend; try sending your message again.`
          : `⚠️ This turn ran past the ${formatDuration(ABSOLUTE_TIMEOUT_MS)} safety limit and was stopped. Everything up to this point is saved — send a follow-up to continue.`;
      const delta = full ? `\n\n${note}` : note;
      full = full ? `${full}\n\n${note}` : note;
      if (!silent) emit(session.id, "message.delta", { text: delta });
    } else if (cancelled) {
      status = "interrupted";
    } else if (!full && code !== 0) {
      const tail = stderr
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-2)
        .join(" ");
      full = `grok exited with code ${code}${tail ? `: ${tail}` : ""}`;
      status = "error";
      if (!silent) emit(session.id, "message.delta", { text: full });
    }
    log(
      `turn end session=${session.id.slice(0, 8)} status=${status} chars=${full.length} reasoning=${reasoning.length}${silent ? " (silent/reflection)" : ""}`
    );
    finish(full, status);
  });

  function finish(content, status) {
    if (finished) return;
    finished = true;
    // Never end a VISIBLE turn with empty text — that is what wedges the
    // desktop thread forever (see EMPTY_TURN_NOTE). Substituted here, before
    // both the persisted message and the emitted message.complete, so the two
    // can never disagree. Reflection turns are invisible and stay untouched.
    if (!silent && !String(content || "").trim()) {
      content = EMPTY_TURN_NOTE;
      log(
        `empty visible turn session=${session.id.slice(0, 8)} status=${status} — substituted stop note`
      );
    }
    clearInterval(watchdogTimer); // no-op if already cleared in the close handler
    toolFeed.stop(); // settle chips before message.complete
    if (!silent) clearTurnKeepalive(session.id);
    // Always settle the turn for the UI. The old early-return when
    // activeTurns was already cleared could skip message.complete and leave
    // Hermes stuck on busy/running with only "queued" chips visible.
    activeTurns.delete(session.id);

    try {
      if (turnUsage) {
        // Cost/usage accounting stays honest even for silent reflection
        // turns — Michael can still see total spend in session.info.
        session.input_tokens =
          (session.input_tokens || 0) + (turnUsage.input_tokens || 0);
        session.output_tokens =
          (session.output_tokens || 0) + (turnUsage.output_tokens || 0);
        session.reasoning_tokens =
          (session.reasoning_tokens || 0) + (turnUsage.reasoning_tokens || 0);
        session.api_call_count = (session.api_call_count || 0) + 1;
      }
      if (!silent) {
        // A reflection turn is not part of the visible conversation — no
        // transcript bubble, no title change from its prompt text.
        session.messages.push({
          role: "assistant",
          content: content || "",
          reasoning: reasoning || null,
          timestamp: nowSec(),
        });
        if (!session.title && text) {
          session.title = String(text).trim().slice(0, 56);
        }
      }
      session.updated_at = nowSec();
      upsertSession(session);
    } catch (e) {
      log(`finish persist error session=${session.id.slice(0, 8)}: ${e.message}`);
    }

    if (!silent) {
      emit(session.id, "message.complete", {
        text: content || "",
        usage: sessionUsage(session),
        status,
        reasoning: reasoning || null,
      });
      emit(session.id, "session.info", sessionInfoPayload(session, false));
      emit(session.id, "session.title", {
        session_id: session.id,
        title: session.title || "",
      });
    } else {
      log(
        `reflection result session=${session.id.slice(0, 8)}: ${
          /NOTHING_TO_SAVE/i.test(content) ? "nothing to save" : content.slice(0, 200)
        }`
      );
    }

    // Drain gateway queue only when we intentionally accepted one (queue /
    // interrupt modes). Default reject mode leaves drain to Hermes Desktop.
    if (!silent && !cancelled && queuedPrompts.get(session.id)?.length) {
      scheduleQueueDrain(session);
    } else if (!silent) {
      queuedPrompts.delete(session.id);
    }

    // Tier 2 self-improvement: only after a genuinely difficult, cleanly
    // completed, VISIBLE turn — never chain reflection off a reflection.
    if (
      !silent &&
      status === "complete" &&
      REFLECT_ENABLED &&
      session.grok_session_id &&
      ((turnNumTurns != null && turnNumTurns >= REFLECT_MIN_NUM_TURNS) ||
        toolFeed.toolStartCount >= REFLECT_MIN_TOOL_CALLS ||
        (turnUsage?.reasoning_tokens || 0) >= REFLECT_MIN_REASONING_TOKENS)
    ) {
      log(
        `scheduling reflection session=${session.id.slice(0, 8)} num_turns=${turnNumTurns} tool_calls=${toolFeed.toolStartCount} reasoning_tokens=${turnUsage?.reasoning_tokens || 0}`
      );
      scheduleReflection(session);
    }
  }
}

/**
 * Fire-and-forget Tier 2 self-improvement pass — see REFLECT_* comment.
 * Deliberately goes through the SAME activeTurns/stall-watchdog/queueing
 * machinery as a real turn (via runGrokTurn's `silent` option) rather than a
 * separate code path: reflection resumes the same grok session, and running
 * it concurrently with a real user turn on that session would race Grok's
 * own on-disk session locks (the exact failure mode fixed in the stall-
 * watchdog work) — activeTurns already makes that impossible by queuing.
 */
function scheduleReflection(session) {
  setImmediate(() => {
    if (activeTurns.has(session.id)) return; // raced a new user prompt — skip, not worth delaying them
    try {
      runGrokTurn(session, REFLECT_PROMPT, { silent: true });
    } catch (e) {
      log(`reflection spawn error session=${session.id.slice(0, 8)}: ${e.message}`);
    }
  });
}

function submitPrompt(session, text) {
  session.messages.push({ role: "user", content: text, timestamp: nowSec() });
  session.updated_at = nowSec();
  if (!session.title) session.title = text.slice(0, 56);
  upsertSession(session);
  runGrokTurn(session, text);
}

function runOneshot(instructions, input, cb) {
  // No --experimental-memory here on purpose: llm.oneshot is a stateless,
  // disconnected helper (e.g. project-idea generation) with no session or
  // --resume — there's no continuity for memory to attach to, so the flag
  // would only add tool-call latency with nothing to show for it.
  const argv = [
    "--output-format",
    "json",
    "--no-auto-update",
    "-m",
    MODEL,
    "--reasoning-effort",
    REASONING_EFFORT,
    "--cwd",
    DEFAULT_CWD,
    "-p",
    `${instructions ? instructions + "\n\n" : ""}${input || ""}`,
  ];
  const proc = spawn(findGrok(), argv, {
    cwd: DEFAULT_CWD,
    // Use whichever account still has weekly balance (no per-turn retry here —
    // a oneshot helper failing is non-fatal and the caller degrades).
    env: childEnv(activeAccount() && activeAccount().home),
    windowsHide: true,
  });
  let out = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c) => (out += c));
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, 90_000);
  proc.on("close", () => {
    clearTimeout(timer);
    let text = "";
    try {
      const parsed = JSON.parse(out);
      text = parsed.result || parsed.text || parsed.response || "";
    } catch {
      text = out.trim();
    }
    cb(String(text));
  });
  proc.on("error", () => {
    clearTimeout(timer);
    cb("");
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────

// Same public set as dashboard_auth/public_paths.py (subset we serve).
const PUBLIC_PATHS = new Set([
  "/api/status",
  "/api/config/defaults",
  "/api/config/schema",
  "/api/model/info",
]);

function authorized(req) {
  const header =
    req.headers["x-hermes-session-token"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  return header === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  const respond = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, X-Hermes-Token, X-Hermes-Session-Token",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    });
    res.end(payload);
    httpLog(req, status, body, Date.now() - started);
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, X-Hermes-Token, X-Hermes-Session-Token",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    });
    return res.end();
  }

  try {
    const p = url.pathname;

    if (!p.startsWith("/api/") && p !== "/health") {
      return respond(404, { detail: "Not Found" });
    }
    if (p !== "/health" && !PUBLIC_PATHS.has(p) && !authorized(req)) {
      return respond(401, { detail: "Unauthorized" });
    }

    // ── status / health ─────────────────────────────────────────────
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (p === "/health" || p === "/api/status")
    ) {
      return respond(200, {
        ok: true,
        service: "grok-gateway",
        version: VERSION,
        release_date: RELEASE_DATE,
        config_version: 1,
        latest_config_version: 1,
        can_update_hermes: false,
        gateway_running: false,
        gateway_state: null,
        gateway_platforms: {},
        gateway_exit_reason: null,
        gateway_updated_at: null,
        active_agents: activeTurns.size,
        gateway_busy: activeTurns.size > 0,
        gateway_drainable: false,
        restart_drain_timeout: 30,
        active_sessions: activeTurns.size,
        auth_required: false,
        auth_providers: [],
        nous_session_valid: "unknown",
        profiles: ["default"],
        gateway_mode: "none",
        hermes_home: DATA,
        config_path: path.join(DATA, "config.yaml"),
        env_path: path.join(DATA, ".env"),
        gateway_pid: null,
        gateway_health_url: null,
        gateways: [],
        model: MODEL,
        provider: PROVIDER,
      });
    }

    if (req.method === "GET" && p === "/api/providers/oauth") {
      return respond(200, { providers: [] });
    }
    if (req.method === "GET" && p === "/api/auth/providers") {
      return respond(503, { detail: "no auth providers registered" });
    }

    // ── model ───────────────────────────────────────────────────────
    if (req.method === "GET" && p === "/api/model/info") {
      return respond(200, {
        model: MODEL,
        provider: PROVIDER,
        auto_context_length: 256000,
        config_context_length: 0,
        effective_context_length: 256000,
        capabilities: {
          supports_tools: true,
          supports_vision: false,
          supports_reasoning: true,
          context_window: 256000,
          max_output_tokens: 32000,
          model_family: "grok",
        },
      });
    }
    if (req.method === "GET" && p === "/api/model/options") {
      return respond(200, {
        model: MODEL,
        provider: PROVIDER,
        providers: [
          {
            name: "Grok CLI",
            slug: PROVIDER,
            is_current: true,
            authenticated: true,
            auth_type: "cli",
            key_env: null,
            warning: null,
            models: [MODEL],
            total_models: 1,
            pricing: {},
            capabilities: { [MODEL]: { fast: false, reasoning: true } },
          },
        ],
      });
    }
    if (req.method === "GET" && p === "/api/model/recommended-default") {
      return respond(200, { provider: PROVIDER, model: MODEL, free_tier: null });
    }
    if (req.method === "GET" && p === "/api/model/auxiliary") {
      const tasks = [
        "vision",
        "web_extract",
        "compression",
        "skills_hub",
        "approval",
        "mcp",
        "title_generation",
        "triage_specifier",
        "kanban_decomposer",
        "profile_describer",
        "curator",
      ].map((task) => ({ task, provider: "auto", model: "", base_url: "" }));
      return respond(200, { tasks, main: { provider: PROVIDER, model: MODEL } });
    }
    if (req.method === "POST" && p === "/api/model/set") {
      return respond(200, {
        ok: true,
        provider: PROVIDER,
        model: MODEL,
        gateway_tools: [],
      });
    }

    // ── config ──────────────────────────────────────────────────────
    if (
      req.method === "GET" &&
      (p === "/api/config" || p === "/api/config/defaults")
    ) {
      return respond(200, {
        model: { default: MODEL, provider: PROVIDER, base_url: "" },
        agent: { reasoning_effort: REASONING_EFFORT, service_tier: "", personalities: {} },
        display: { personality: "", skin: "" },
        terminal: { cwd: DEFAULT_CWD },
        stt: { enabled: false },
        voice: { max_recording_seconds: 120, auto_tts: false },
        memory: {},
        auxiliary: {},
        mcp_servers: {},
      });
    }
    if (req.method === "PUT" && p === "/api/config") {
      return respond(200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/config/schema") {
      return respond(200, { fields: [], category_order: [] });
    }

    // ── profiles ────────────────────────────────────────────────────
    if (req.method === "GET" && p === "/api/profiles") {
      return respond(200, {
        profiles: [
          {
            name: "default",
            path: DATA,
            is_default: true,
            model: MODEL,
            provider: PROVIDER,
            has_env: false,
            skill_count: 0,
            gateway_running: false,
            description: "Grok Build (CLI)",
            description_auto: false,
            distribution_name: null,
            distribution_version: null,
            distribution_source: null,
            has_alias: false,
          },
        ],
      });
    }
    if (req.method === "GET" && p === "/api/profiles/active") {
      return respond(200, { active: "default", current: "default" });
    }

    // ── sessions ────────────────────────────────────────────────────
    if (
      req.method === "GET" &&
      (p === "/api/sessions" || p === "/api/profiles/sessions")
    ) {
      const withProfile = p === "/api/profiles/sessions";
      const { rows, page, limit, offset } = filterSessions(url.searchParams);
      const body = {
        sessions: page.map((s) => sessionRow(s, withProfile)),
        total: rows.length,
        limit,
        offset,
      };
      if (withProfile) {
        body.profile_totals = { default: rows.length };
        body.errors = [];
      }
      return respond(200, body);
    }
    // Batched sidebar slices (new in upstream 98cadad / desktop_contract 4):
    // one call replacing the three /api/profiles/sessions section queries.
    // Shape: {recents:{sessions,total,profile_totals}, cron:{sessions},
    //         messaging:{sessions}, errors:[]}
    if (req.method === "GET" && p === "/api/profiles/sessions/sidebar") {
      const cap = Math.min(
        Math.max(Number(url.searchParams.get("recents_limit") || 20), 1),
        500
      );
      const params = new URLSearchParams({
        limit: String(cap),
        offset: "0",
        min_messages: "1",
        archived: "exclude",
        order: "recent",
      });
      const exclude = url.searchParams.get("recents_exclude");
      if (exclude) params.set("exclude_sources", exclude);
      const { rows, page } = filterSessions(params);
      return respond(200, {
        recents: {
          sessions: page.map((s) => sessionRow(s, true)),
          total: rows.length,
          profile_totals: { default: rows.length },
        },
        cron: { sessions: [] },
        messaging: { sessions: [] },
        errors: [],
      });
    }

    if (req.method === "GET" && p === "/api/sessions/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      if (!q) return respond(200, { results: [] });
      const data = loadStore();
      const results = [];
      for (const s of data.sessions) {
        for (const m of s.messages || []) {
          const content = String(m.content || "");
          if (content.toLowerCase().includes(q)) {
            results.push({
              snippet: content.slice(0, 160),
              role: m.role,
              source: "desktop",
              model: s.model || MODEL,
              session_started: s.created_at,
              session_id: s.id,
              lineage_root: s.id,
            });
            break;
          }
        }
        if (results.length >= 20) break;
      }
      return respond(200, { results });
    }
    if (req.method === "GET" && p === "/api/sessions/stats") {
      const data = loadStore();
      const archived = data.sessions.filter((s) => s.archived).length;
      return respond(200, {
        total: data.sessions.length,
        active_store: 0,
        archived,
        messages: data.sessions.reduce(
          (n, s) => n + (s.messages || []).length,
          0
        ),
        by_source: { desktop: data.sessions.length },
      });
    }
    if (req.method === "GET" && p === "/api/sessions/empty/count") {
      return respond(200, { count: 0 });
    }

    const sessMatch = p.match(
      /^\/api\/sessions\/([^/]+)(?:\/(messages|export|latest-descendant))?$/
    );
    if (sessMatch) {
      const id = decodeURIComponent(sessMatch[1]);
      const sub = sessMatch[2];
      const session = getSession(id);
      if (!session) return respond(404, { detail: "Session not found" });

      if (req.method === "GET" && !sub) {
        const row = sessionRow(session, false);
        row.archived = session.archived ? 1 : 0; // detail row uses raw 0/1
        row.system_prompt = null;
        row.model_config = null;
        return respond(200, row);
      }
      if (req.method === "GET" && sub === "messages") {
        const messages = restMessages(session);
        return respond(200, {
          session_id: session.id,
          messages,
          pagination: { limit: null, offset: 0, returned: messages.length },
        });
      }
      if (req.method === "GET" && sub === "latest-descendant") {
        return respond(200, {
          requested_session_id: id,
          session_id: session.id,
          path: [session.id],
          changed: false,
        });
      }
      if (req.method === "DELETE" && !sub) {
        const data = loadStore();
        data.sessions = data.sessions.filter((s) => s.id !== session.id);
        saveStore(data);
        return respond(200, { ok: true });
      }
      if (req.method === "PATCH" && !sub) {
        const body = (await readBody(req)) || {};
        const out = { ok: true };
        if (typeof body.title === "string") session.title = body.title;
        if (typeof body.archived === "boolean") {
          session.archived = body.archived;
          out.archived = body.archived;
        }
        session.updated_at = nowSec();
        upsertSession(session);
        out.title = session.title || "";
        return respond(200, out);
      }
    }

    // ── sidebar/settings sections ───────────────────────────────────
    if (req.method === "GET" && p === "/api/skills") {
      return respond(200, []);
    }
    if (req.method === "GET" && p === "/api/skills/hub/sources") {
      return respond(200, {
        sources: [],
        index_available: false,
        featured: [],
        installed: [],
      });
    }
    if (req.method === "GET" && p === "/api/tools/toolsets") {
      return respond(200, []);
    }
    if (req.method === "GET" && p === "/api/tools/computer-use/status") {
      return respond(200, {
        platform: process.platform,
        platform_supported: false,
        installed: false,
        version: null,
        ready: null,
        can_grant: false,
        checks: [],
        source: null,
        error: null,
      });
    }
    if (req.method === "GET" && p === "/api/env") {
      return respond(200, {});
    }
    if (req.method === "GET" && p === "/api/memory") {
      return respond(200, {
        active: "",
        providers: [],
        builtin_files: { memory: 0, user: 0 },
      });
    }
    if (req.method === "GET" && p === "/api/cron/jobs") {
      return respond(200, []);
    }
    if (req.method === "GET" && p === "/api/cron/delivery-targets") {
      return respond(200, {
        targets: [
          {
            id: "local",
            name: "Local (save only)",
            home_target_set: true,
            home_env_var: null,
          },
        ],
      });
    }
    if (req.method === "GET" && p === "/api/cron/blueprints") {
      return respond(200, { blueprints: [] });
    }
    if (req.method === "GET" && p === "/api/analytics/usage") {
      return respond(200, {
        daily: [],
        by_model: [],
        totals: {
          total_input: null,
          total_output: null,
          total_cache_read: null,
          total_reasoning: null,
          total_estimated_cost: 0,
          total_actual_cost: 0,
          total_sessions: null,
          total_api_calls: null,
        },
        period_days: Number(url.searchParams.get("days") || 30),
        skills: {
          summary: {
            total_skill_loads: 0,
            total_skill_edits: 0,
            total_skill_actions: 0,
            distinct_skills_used: 0,
          },
          top_skills: [],
        },
        tools: [],
      });
    }
    if (req.method === "GET" && p === "/api/logs") {
      return respond(200, { file: "agent", lines: [] });
    }
    if (req.method === "GET" && p === "/api/portal") {
      return respond(200, {
        logged_in: false,
        portal_url: null,
        inference_url: null,
        provider: PROVIDER,
        subscription_url: null,
        features: [],
      });
    }
    if (req.method === "GET" && p === "/api/curator") {
      return respond(200, {
        enabled: false,
        paused: true,
        interval_hours: null,
        last_run_at: null,
        min_idle_hours: null,
        stale_after_days: null,
        archive_after_days: null,
      });
    }
    if (req.method === "GET" && p === "/api/system/stats") {
      return respond(200, {
        os: "Windows",
        os_release: os.release(),
        os_version: os.release(),
        platform: `${os.type()}-${os.release()}`,
        arch: process.arch,
        hostname: os.hostname(),
        python_version: "",
        python_impl: "",
        hermes_version: VERSION,
        cpu_count: os.cpus().length,
        psutil: false,
      });
    }
    if (req.method === "GET" && p === "/api/hermes/update/check") {
      return respond(200, {
        install_method: "external",
        current_version: VERSION,
        behind: 0,
        update_available: false,
        can_apply: false,
        update_command: null,
        message: null,
        commits: [],
      });
    }

    // ── fs ──────────────────────────────────────────────────────────
    if (req.method === "GET" && p === "/api/fs/default-cwd") {
      return respond(200, { cwd: DEFAULT_CWD, branch: null });
    }
    if (req.method === "GET" && p === "/api/fs/list") {
      const target = url.searchParams.get("path") || DEFAULT_CWD;
      try {
        const entries = fs
          .readdirSync(target, { withFileTypes: true })
          .map((d) => ({
            name: d.name,
            path: path.join(target, d.name),
            isDirectory: d.isDirectory(),
          }))
          .sort(
            (a, b) =>
              Number(b.isDirectory) - Number(a.isDirectory) ||
              a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          );
        return respond(200, { entries });
      } catch (e) {
        return respond(200, { entries: [], error: e.code || String(e.message) });
      }
    }
    if (req.method === "GET" && p === "/api/fs/git-root") {
      return respond(200, { root: null });
    }

    // Unknown /api/* — 404 with FastAPI's error shape. The renderer catches
    // rejections everywhere; it is wrong-shaped 200s that crash it.
    return respond(404, { detail: "Not Found" });
  } catch (err) {
    log(`http error ${req.method} ${req.url}: ${err.stack || err.message}`);
    return respond(500, { detail: String(err?.message || err) });
  }
});

// ── WebSocket JSON-RPC ────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (url.pathname !== "/api/ws") {
    socket.destroy();
    return;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Methods that exist in real Hermes but are feature surfaces we don't back.
// Callers catch RPC errors; a JSON-RPC error is safer than a fake shape.
const UNSUPPORTED_OK = new Set([
  "config.set",
  "reload.mcp",
  "reload.env",
  "terminal.resize",
  "paste.collapse",
  "session.save",
  "session.steer",
]);

wss.on("connection", (ws) => {
  sockets.add(ws);
  log(`ws connect (${sockets.size} open)`);

  send(ws, {
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { skin: {} } },
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }

    const id = msg.id;
    const method = msg.method;
    const params = msg.params || {};

    const ok = (result) => {
      if (id !== undefined && id !== null)
        send(ws, { jsonrpc: "2.0", id, result });
    };
    const err = (code, message) => {
      if (id !== undefined && id !== null)
        send(ws, { jsonrpc: "2.0", id, error: { code, message } });
    };

    try {
      switch (method) {
        case "session.create": {
          const session = createSession({
            cwd: params.cwd || DEFAULT_CWD,
            model: params.model || MODEL,
            title: params.title,
          });
          ok({
            session_id: session.id,
            stored_session_id: session.id,
            message_count: 0,
            messages: [],
            info: sessionInfoPayload(session, false),
          });
          emit(session.id, "session.info", sessionInfoPayload(session, false));
          return;
        }

        case "session.resume": {
          let session = params.session_id ? getSession(params.session_id) : null;
          if (!session) {
            // Soft-create with the requested id so the desktop's stored
            // binding survives a gateway restart.
            session = createSession({
              id: params.session_id || undefined,
              cwd: params.cwd || DEFAULT_CWD,
              model: params.model || MODEL,
            });
          }
          const running = activeTurns.has(session.id);
          ok({
            session_id: session.id,
            resumed: session.id,
            message_count: (session.messages || []).length,
            messages: displayMessages(session),
            info: sessionInfoPayload(session, running),
            inflight: null,
            running,
            session_key: session.id,
            started_at: session.created_at,
            status: running ? "streaming" : "idle",
          });
          return;
        }

        case "prompt.submit": {
          let session = params.session_id ? getSession(params.session_id) : null;
          // These two early-returns used to be SILENT. During the 2026-07-25
          // wedge that made the logs actively misleading: a rejected submit
          // looked identical to no submit at all, so "the UI is stuck" and
          // "the gateway refused it" were indistinguishable. Always log.
          if (!session) {
            log(`prompt reject: session not found id=${String(params.session_id || "-").slice(0, 8)}`);
            return err(4001, "session not found");
          }
          const text = String(params.text || "").trim();
          if (!text) {
            log(`prompt reject: empty prompt session=${session.id.slice(0, 8)}`);
            return err(-32602, "empty prompt");
          }
          if (params.cwd && typeof params.cwd === "string")
            session.cwd = params.cwd;

          if (activeTurns.has(session.id)) {
            // Hermes Desktop ignores the JSON body of a successful
            // prompt.submit and keeps busy/awaitingResponse true. Returning
            // {status:"queued"} therefore looks like a live turn with a dead
            // feed. Prefer 4009 so the composer's local queue + auto-drain run
            // (same path as native "session busy" retries).
            if (BUSY_MODE === "queue") {
              const n = enqueueGatewayPrompt(session.id, text);
              log(
                `busy queue session=${session.id.slice(0, 8)} depth=${n} mode=queue`
              );
              ok({ status: "queued" });
              return;
            }
            if (BUSY_MODE === "interrupt") {
              const n = enqueueGatewayPrompt(session.id, text);
              log(
                `busy queue session=${session.id.slice(0, 8)} depth=${n} mode=interrupt`
              );
              const turn = activeTurns.get(session.id);
              if (turn) turn.cancel();
              ok({ status: "queued" });
              return;
            }
            log(
              `busy reject session=${session.id.slice(0, 8)} mode=${BUSY_MODE || "reject"}`
            );
            return err(4009, "session busy");
          }

          ok({ status: "streaming" });
          submitPrompt(session, text);
          return;
        }

        case "session.interrupt": {
          const turn = params.session_id
            ? activeTurns.get(params.session_id)
            : null;
          // Keep gateway queue on interrupt in interrupt-mode (native drains
          // it after the cancelled turn). Clear it otherwise so Stop does not
          // surprise-fire a leftover prompt.
          if (BUSY_MODE !== "interrupt") {
            queuedPrompts.delete(params.session_id);
          }
          if (turn) turn.cancel();
          ok({ status: "interrupted" });
          return;
        }

        case "session.close": {
          ok({ ok: true });
          return;
        }

        case "session.title": {
          const session = getSession(params.session_id);
          if (!session) return err(4001, "session not found");
          if (typeof params.title === "string") {
            session.title = params.title;
            session.updated_at = nowSec();
            upsertSession(session);
            emit(session.id, "session.title", {
              session_id: session.id,
              title: session.title,
            });
          }
          ok({ ok: true, title: session.title || "" });
          return;
        }

        case "session.cwd.set": {
          const session = getSession(params.session_id);
          if (!session) return err(4001, "session not found");
          if (params.cwd && typeof params.cwd === "string") {
            session.cwd = params.cwd;
            session.updated_at = nowSec();
            upsertSession(session);
            emit(
              session.id,
              "session.info",
              sessionInfoPayload(session, activeTurns.has(session.id))
            );
          }
          ok({ cwd: session.cwd, branch: null });
          return;
        }

        case "session.usage": {
          const session = getSession(params.session_id);
          if (!session) return err(4001, "session not found");
          ok(sessionUsage(session));
          return;
        }

        case "session.delete": {
          const session = getSession(params.session_id);
          if (session) {
            const data = loadStore();
            data.sessions = data.sessions.filter((s) => s.id !== session.id);
            saveStore(data);
          }
          ok({ ok: true });
          return;
        }

        case "model.options": {
          ok({
            model: MODEL,
            provider: PROVIDER,
            providers: [
              {
                name: "Grok CLI",
                slug: PROVIDER,
                is_current: true,
                authenticated: true,
                auth_type: "cli",
                key_env: null,
                warning: null,
                models: [MODEL],
                total_models: 1,
                pricing: {},
                capabilities: { [MODEL]: { fast: false, reasoning: true } },
              },
            ],
          });
          return;
        }

        case "setup.status": {
          ok({ provider_configured: true });
          return;
        }

        case "setup.runtime_check": {
          ok({ ok: true, provider: PROVIDER, model: MODEL, source: "cli" });
          return;
        }

        case "config.get": {
          // Desktop uses {key:'project', cwd} to normalize a workspace pick.
          if (params.key === "project") {
            const cwd =
              params.cwd && typeof params.cwd === "string"
                ? params.cwd
                : DEFAULT_CWD;
            ok({ cwd, branch: null });
            return;
          }
          ok({ key: params.key ?? null, value: null });
          return;
        }

        case "projects.list": {
          ok({ projects: [], active: null });
          return;
        }

        case "process.list": {
          ok({ processes: [] });
          return;
        }

        case "commands.catalog": {
          ok({ commands: [], categories: [] });
          return;
        }

        case "complete.path":
        case "complete.slash": {
          ok({ items: [] });
          return;
        }

        case "llm.oneshot": {
          const instructions = String(params.instructions || "");
          const input = String(params.input || "");
          if (!instructions && !input)
            return err(4030, "llm.oneshot requires instructions/input");
          runOneshot(instructions, input, (text) => ok({ text }));
          return;
        }

        default: {
          if (UNSUPPORTED_OK.has(method)) {
            ok({ ok: true });
            return;
          }
          err(-32601, `Unknown method: ${method}`);
          return;
        }
      }
    } catch (e) {
      log(`rpc error ${method}: ${e.stack || e.message}`);
      err(-32603, String(e?.message || e));
    }
  });

  ws.on("close", () => {
    sockets.delete(ws);
    log(`ws close (${sockets.size} open)`);
  });
  ws.on("error", (e) => {
    log(`ws error: ${e.message}`);
  });
});

server.listen(PORT, HOST, () => {
  log(`grok-gateway v2 listening on http://${HOST}:${PORT}`);
  log(`grok binary: ${findGrok()}`);
  log(`data dir:    ${DATA}`);
  log(`default cwd: ${DEFAULT_CWD}`);
});
