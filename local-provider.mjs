/**
 * Frozen Local provider — a per-session alternative to grok.exe that runs the
 * REAL Hermes agent (its own tool loop: terminal, files, search, web) against
 * the LM Studio model loaded on the Frozen-RGB PC.
 *
 * Why Hermes and not a raw chat completion: grok.exe gives Grok Build its agent
 * loop and tools. A bare /v1/chat/completions call has none, so it could only
 * talk. The installed Hermes (b2aa855b) already ships LM Studio as a first-class
 * provider AND an ACP stdio server (`hermes acp`), so we reuse that agent
 * instead of writing a tool loop of our own.
 *
 * Transport:  gateway ──ACP stdio──> hermes acp ──HTTP──> 127.0.0.1:12345
 *             ──SSH -L──> Frozen-RGB 127.0.0.1:1234 (LM Studio, loopback only)
 *
 * Safety rules this module enforces (each learned from the Frozen handoff):
 *  - Frozen is SHARED with Bionic and serves ONE request at a time. At most one
 *    local turn runs across the whole gateway; callers wait for the slot, and we
 *    look at Frozen's own queue so the user sees "waiting for Bionic" instead of
 *    a silent hang.
 *  - Never load over someone else's model. Loading is allowed ONLY when Frozen
 *    has no chat model loaded at all (Michael's call, 2026-09-13: LM Studio Bionic
 *    idle-unloads after an hour, and restarts come back empty). The decision is
 *    re-made from a fresh probe while holding the Frozen slot, the load goes
 *    through `lms load` with the context the model last ran with and a 1-hour
 *    TTL, and success is confirmed on LM Studio's own list before anything is
 *    sent. If ANY other model is loaded, the turn is refused — never swapped.
 *    The Hermes profile runs lmstudio_load_mode=jit so Hermes itself never
 *    preloads, and turns only name a model that is already loaded (LM Studio
 *    would JIT-load any DOWNLOADED model a request names, evicting Bionic's).
 *  - Only ever stop the tunnel THIS process started. Never kill another app's ssh.
 *  - Never fall back to the cloud. A local failure is a clear local error.
 *  - Grok Build's [permission] deny list is mirrored into the profile by the
 *    grok-deny-mirror Hermes plugin (hermes-profile/plugins/), so a local session
 *    cannot write where Grok itself may not.
 */
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export const LOCAL_SLUG = "frozen-local";
export const LOCAL_LABEL = "Frozen Local";

/** Hermes' own floor for reliable tool calling (agent/model_metadata.py MINIMUM_CONTEXT_LENGTH). */
export const HERMES_CONTEXT_FLOOR = 64_000;
/** Below this the agent can't run at all: its instructions + tool schemas alone measured ~7.3K tokens. */
export const MIN_AGENT_CONTEXT = Number(process.env.FROZEN_MIN_CONTEXT || 16_384);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/post-quantum|store now|openssh\.com\/pq|may need to be upgraded/i.test(l))[0] || "";

/* ── pure helpers (exported for tests) ─────────────────────────────────── */

/**
 * Parse the desktop's model-switch value. The stock desktop sends
 * `config.set {key:"model", value:"<model> --provider <slug>[ --session]"}`
 * (apps/desktop/src/app/session/hooks/use-model-controls.ts).
 */
export function parseModelSwitch(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const tokens = raw.split(/\s+/);
  let provider = "";
  let session = false;
  const modelParts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--provider" && i + 1 < tokens.length) provider = tokens[++i];
    else if (t.startsWith("--provider=")) provider = t.slice("--provider=".length);
    else if (t === "--session") session = true;
    else if (t.startsWith("--")) continue; // unknown flag: ignore rather than fold into the model id
    else modelParts.push(t);
  }
  const model = modelParts.join(" ");
  if (!model) return null;
  return { model, provider, session };
}

/** Loaded chat models from LM Studio's native /api/v0/models payload. */
export function loadedModelsFrom(payload) {
  return ((payload && payload.data) || [])
    .filter((m) => m && m.state === "loaded" && (m.type === "llm" || m.type === "vlm"))
    .map((m) => ({
      id: m.id,
      contextLength: m.loaded_context_length || null,
      maxContextLength: m.max_context_length || null,
      type: m.type,
      // true / false from LM Studio's capabilities; null when it doesn't say.
      toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : null,
    }));
}

/** Every chat model LM Studio lists — downloaded, loaded or not — from /api/v0/models. */
export function downloadedModelsFrom(payload) {
  return ((payload && payload.data) || [])
    .filter((m) => m && (m.type === "llm" || m.type === "vlm"))
    .map((m) => ({
      id: m.id,
      maxContextLength: m.max_context_length || null,
      type: m.type,
      toolUse: Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : null,
      loaded: m.state === "loaded",
    }));
}

/**
 * What may a chat do with Frozen as it is right now? Pure.
 *   use            the chat's model is loaded
 *   load           NOTHING is loaded and the model is downloaded — loading it evicts nothing
 *   other-loaded   a different model is loaded (likely Bionic's) — never swap it out
 *   not-downloaded nothing to load
 */
export function planModel(target, { loaded, downloaded }) {
  const hit = (loaded || []).find((m) => m.id === target);
  if (hit) return { action: "use", model: hit };
  if ((loaded || []).length) return { action: "other-loaded", loaded };
  const d = (downloaded || []).find((m) => m.id === target);
  if (!d) return { action: "not-downloaded" };
  return { action: "load", model: d };
}

/** The user-facing refusal for a plan, or null when the plan can proceed. Pure. */
export function planRefusal(plan, target) {
  if (!plan) return null;
  if (plan.action === "other-loaded") {
    const names = plan.loaded.map((m) => m.id).join(", ");
    return (
      `\`${target}\` isn't loaded on Frozen — it has ${names} loaded right now (probably Bionic's), ` +
      `and Grok Build only replaces a loaded model after you confirm. Pick \`${target}\` in the model menu ` +
      `again and confirm replacing ${names}, or pick ${names} to use what's loaded.`
    );
  }
  if (plan.action === "not-downloaded") {
    return `\`${target}\` isn't downloaded on Frozen, so there's nothing to load. Pick another model from the model menu.`;
  }
  return null;
}

const sameIdSet = (a, b) => {
  const A = [...new Set(a)].sort(), B = [...new Set(b)].sort();
  return A.length === B.length && A.every((x, i) => x === B[i]);
};

/**
 * May this turn replace what's loaded? Only with a swap token the user earned
 * by confirming in the model menu, and only while Frozen still holds exactly
 * the models that confirm was about — if Bionic loaded something else in the
 * meantime, the user never agreed to evict it. Pure.
 *   { allowed:true, replacing:[ids] } | { allowed:false, needsConfirm:true, replacing:[ids] }
 */
export function swapDecision(plan, target, token) {
  const replacing = (plan && plan.loaded ? plan.loaded : []).map((m) => m.id);
  if (!plan || plan.action !== "other-loaded") return { allowed: false, needsConfirm: false, replacing };
  const ok = !!token && token.to === target && Array.isArray(token.replacing) && sameIdSet(token.replacing, replacing);
  return ok ? { allowed: true, replacing } : { allowed: false, needsConfirm: true, replacing };
}

/** The confirm shown by the desktop before a swap. Pure. */
export function swapConfirmMessage(target, replacing) {
  const names = replacing.join(", ");
  return (
    `Frozen currently has ${names} loaded — possibly in use by Bionic. Switching this chat to ` +
    `\`${target}\` will unload ${names} and load \`${target}\` on your next message (about a minute). ` +
    `Continue?`
  );
}

/**
 * Per-model context lengths from original Hermes' config.yaml
 * (`providers: lmstudio: models: <id>: context_length: N`) — the settings
 * Michael already maintains for the same models. Minimal indentation-aware
 * parse; no YAML dependency in the gateway. Pure.
 */
export function hermesConfigContexts(yamlText) {
  const out = {};
  const lines = String(yamlText || "").split(/\r?\n/);
  const indent = (l) => l.match(/^\s*/)[0].length;
  let i = lines.findIndex((l) => /^providers:\s*$/.test(l));
  if (i < 0) return out;
  const provIndent = indent(lines[i]);
  // find `lmstudio:` inside providers
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === "" || indent(lines[j]) > provIndent)) {
    if (/^\s*lmstudio:\s*$/.test(lines[j])) break;
    j++;
  }
  if (j >= lines.length || !/^\s*lmstudio:\s*$/.test(lines[j])) return out;
  const lmIndent = indent(lines[j]);
  let k = j + 1;
  while (k < lines.length && (lines[k].trim() === "" || indent(lines[k]) > lmIndent)) {
    if (/^\s*models:\s*$/.test(lines[k])) break;
    k++;
  }
  if (k >= lines.length || !/^\s*models:\s*$/.test(lines[k])) return out;
  const modelsIndent = indent(lines[k]);
  let current = null;
  for (let n = k + 1; n < lines.length; n++) {
    const l = lines[n];
    if (l.trim() === "") continue;
    const ind = indent(l);
    if (ind <= modelsIndent) break;
    const key = l.match(/^\s*("?)([^":#]+(?::[^":#]+)*)\1:\s*(.*)$/);
    if (!key) continue;
    if (ind === modelsIndent + 2) { current = key[2].trim(); continue; }
    if (current && key[2].trim() === "context_length") {
      const v = Number(key[3].trim());
      if (Number.isFinite(v) && v > 0) out[current] = v;
    }
  }
  return out;
}

/**
 * Context to load a model with: what it last ran with (remembered), else a
 * Hermes-safe default, never above the model's own maximum. Pure.
 */
export function chooseLoadContext(model, remembered, { override = null, hermes = null, fallback = 65536 } = {}) {
  // Priority: explicit override > what it last ran with here > original Hermes' setting > default.
  const want =
    Number(override) > 0 ? Number(override)
    : (remembered && remembered.contextLength) || (Number(hermes) > 0 ? Number(hermes) : 0) || fallback;
  const max = model && model.maxContextLength;
  return Math.floor(max ? Math.min(want, max) : want);
}

/**
 * A model id is placed inside a remote shell command (`lms load "<id>"`), so
 * only allow the characters LM Studio ids actually use. Pure.
 */
export function isSafeModelId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._\-/@:]{0,199}$/.test(id);
}

/**
 * The exact remote command that loads a model on Frozen. One builder so the
 * string tests exercise is the string production runs. Flags verified against
 * Frozen's installed CLI (`lms load --help`, 2026-09-13). Pure; throws on an
 * unsafe id or non-positive numbers.
 */
export function lmsLoadCommand(id, contextLength, ttlSeconds, { estimateOnly = false } = {}) {
  if (!isSafeModelId(id)) throw new Error(`unsafe model id: ${id}`);
  const ctx = Math.floor(Number(contextLength));
  const ttl = Math.floor(Number(ttlSeconds));
  if (!(ctx > 0) || !(ttl > 0)) throw new Error(`invalid load numbers ctx=${contextLength} ttl=${ttlSeconds}`);
  return `lms load "${id}" --context-length ${ctx} --ttl ${ttl} --identifier "${id}"${estimateOnly ? " --estimate-only" : ""} -y`;
}

/** `lms unload "<identifier>"` — one model, never `--all` (that would take the embedding model too). Pure. */
export function lmsUnloadCommand(id) {
  if (!isSafeModelId(id)) throw new Error(`unsafe model id: ${id}`);
  return `lms unload "${id}"`;
}

/**
 * Hermes reports a session's model as "<provider>:<model>" (acp_adapter
 * model_catalog.encode_model_choice). Strip exactly the provider prefix — LM
 * Studio model ids may themselves contain colons.
 */
export function modelFromChoice(choice) {
  const s = String(choice || "");
  return s.startsWith("lmstudio:") ? s.slice("lmstudio:".length) : s;
}

/**
 * Is this loaded model usable by the agent? `refuse` blocks selection and turns;
 * `warn` is shown in the picker and once when a chat first uses the model.
 */
export function assessModel(m, minContext = MIN_AGENT_CONTEXT) {
  const out = { refuse: null, warn: [] };
  if (!m) return out;
  const ctx = m.contextLength;
  if (typeof ctx === "number" && ctx > 0) {
    if (ctx < minContext) {
      out.refuse =
        `${m.id} is loaded with only ${ctx.toLocaleString("en-US")} tokens of context — too small for the local agent ` +
        `(its instructions and tool list alone take about 7-8K). Reload it in LM Studio with at least ` +
        `${HERMES_CONTEXT_FLOOR / 1000}K context.`;
    } else if (ctx < HERMES_CONTEXT_FLOOR) {
      out.warn.push(
        `${m.id} is loaded with ${ctx.toLocaleString("en-US")} context; Hermes recommends at least ` +
          `${HERMES_CONTEXT_FLOOR / 1000}K for reliable tool use, so long tasks may lose track.`
      );
    }
  }
  if (m.toolUse === false) {
    out.warn.push(`LM Studio doesn't mark ${m.id} as tool-capable, so the agent's tool use may be unreliable.`);
  }
  return out;
}

/**
 * Map one ACP session update to the desktop events the Grok path already emits.
 * `state` carries per-turn bookkeeping ({tools: Map, seq}). Returns
 * [{type, payload, text?, reasoning?}] — text/reasoning tell the caller what to
 * accumulate for the persisted transcript. Unknown update kinds map to nothing.
 */
export function mapAcpUpdate(update, state, sessionId) {
  const out = [];
  if (!update || !update.sessionUpdate) return out;
  const kind = update.sessionUpdate;
  const chip = (id) => `${String(sessionId).slice(0, 8)}-L${id}`;

  if (kind === "agent_message_chunk") {
    const c = update.content;
    if (c && c.type === "text" && c.text) out.push({ type: "message.delta", payload: { text: c.text }, text: c.text });
  } else if (kind === "agent_thought_chunk") {
    const c = update.content;
    if (c && c.type === "text" && c.text) out.push({ type: "reasoning.delta", payload: { text: c.text }, reasoning: c.text });
  } else if (kind === "tool_call") {
    const name = String(update.title || update.kind || "tool").slice(0, 120);
    const rec = { tool_id: chip(++state.seq), name, startedAt: Date.now(), done: false };
    state.tools.set(update.toolCallId, rec);
    out.push({ type: "tool.start", payload: { tool_id: rec.tool_id, name } });
    if (update.status === "completed" || update.status === "failed") {
      rec.done = true;
      const payload = { tool_id: rec.tool_id, name, duration_ms: 0 };
      if (update.status === "failed") payload.error = "failed";
      out.push({ type: "tool.complete", payload });
    }
  } else if (kind === "tool_call_update") {
    let rec = state.tools.get(update.toolCallId);
    if (!rec) {
      // An update for a call we never saw start (e.g. after a resume): open a chip first.
      const name = String(update.title || update.kind || "tool").slice(0, 120);
      rec = { tool_id: chip(++state.seq), name, startedAt: Date.now(), done: false };
      state.tools.set(update.toolCallId, rec);
      out.push({ type: "tool.start", payload: { tool_id: rec.tool_id, name } });
    }
    if (update.title && !rec.done) rec.name = String(update.title).slice(0, 120);
    if ((update.status === "completed" || update.status === "failed") && !rec.done) {
      rec.done = true;
      const payload = { tool_id: rec.tool_id, name: rec.name, duration_ms: Date.now() - rec.startedAt };
      if (update.status === "failed") payload.error = "failed";
      out.push({ type: "tool.complete", payload });
    }
  } else if (kind === "usage_update") {
    if (typeof update.used === "number") state.contextUsed = update.used;
    if (typeof update.size === "number") state.contextSize = update.size;
  }
  return out;
}

/** Close every still-open chip (turn ended while tools were running). */
export function settleOpenTools(state, error) {
  const out = [];
  for (const rec of state.tools.values()) {
    if (rec.done) continue;
    rec.done = true;
    const payload = { tool_id: rec.tool_id, name: rec.name, duration_ms: Date.now() - rec.startedAt };
    if (error) payload.error = error;
    out.push({ type: "tool.complete", payload });
  }
  return out;
}

/** Choose the ACP permission option matching the approval policy. */
export function choosePermission(options, policy) {
  const opts = Array.isArray(options) ? options : [];
  if (policy === "allow") {
    const pick = opts.find((o) => o.kind === "allow_once") || opts.find((o) => o.kind === "allow_always");
    if (pick) return { outcome: { outcome: "selected", optionId: pick.optionId } };
  } else {
    const pick = opts.find((o) => o.kind === "reject_once") || opts.find((o) => o.kind === "reject_always");
    if (pick) return { outcome: { outcome: "selected", optionId: pick.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** Rewrite keys inside the top-level `model:` block of a Hermes config.yaml, preserving everything else. */
export function upsertModelBlock(yamlText, values) {
  const lines = String(yamlText || "").split(/\r?\n/);
  let start = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (start < 0) {
    const block = ["model:", ...Object.entries(values).map(([k, v]) => `  ${k}: ${v}`)];
    return [...block, ...lines.filter((l, i) => !(i === lines.length - 1 && l === ""))].join("\n") + "\n";
  }
  let end = start + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === "")) end++;
  const body = lines.slice(start + 1, end);
  for (const [k, v] of Object.entries(values)) {
    const i = body.findIndex((l) => new RegExp(`^\\s+${k}:`).test(l));
    if (i >= 0) body[i] = `  ${k}: ${v}`;
    else body.push(`  ${k}: ${v}`);
  }
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join("\n");
}

/* ── the provider ──────────────────────────────────────────────────────── */

export function createFrozenLocal({ log, dataDir, repoDir, defaultCwd }) {
  const env = process.env;
  const cfg = {
    sshTarget: env.FROZEN_SSH_TARGET || "anyae@192.168.50.140",
    sshKey: env.FROZEN_SSH_KEY || path.join(os.homedir(), ".ssh", "frozen_rgb_control_ed25519"),
    remotePort: Number(env.FROZEN_REMOTE_PORT || 1234),
    localPort: Number(env.FROZEN_LOCAL_PORT || 12345),
    hermesExe:
      env.FROZEN_HERMES_EXE ||
      path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"),
    hermesHome: env.FROZEN_HERMES_HOME || path.join(dataDir, "hermes-local"),
    // Grok Build runs grok.exe with --always-approve; "allow" keeps that parity.
    // The deny-mirror plugin still hard-blocks protected paths before any approval.
    approvals: String(env.FROZEN_LOCAL_APPROVALS || "allow").toLowerCase() === "deny" ? "deny" : "allow",
    busyMaxWaitMs: Number(env.FROZEN_BUSY_MAX_WAIT_MS || 10 * 60 * 1000),
    // When NOTHING is loaded on Frozen, a turn loads its chat's model. The TTL
    // mirrors LM Studio Bionic's own idle unload (jitModelTTL 3600s), so a
    // model Grok Build loads frees the GPU for Bionic after an hour idle too.
    loadTtlSeconds: Number(env.FROZEN_LOAD_TTL_SECONDS || 3600),
    loadContext: env.FROZEN_LOAD_CONTEXT ? Number(env.FROZEN_LOAD_CONTEXT) : null,
    loadTimeoutMs: Number(env.FROZEN_LOAD_TIMEOUT_MS || 5 * 60 * 1000),
    modelsFile: path.join(dataDir, "frozen-models.json"), // context each model last ran with
    // Original Hermes' config.yaml: its `providers.lmstudio.models.<id>.context_length`
    // entries are reused as the context for models this gateway hasn't run yet.
    hermesConfig: env.FROZEN_HERMES_CONFIG ||
      path.join(env.HERMES_HOME || path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes"), "config.yaml"),
  };
  const baseUrl = `http://127.0.0.1:${cfg.localPort}/v1`;

  const sshBin = () => {
    const sys = path.join(env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    return process.platform === "win32" && fs.existsSync(sys) ? sys : "ssh";
  };
  // Test seam: FROZEN_SSH_CMD='["<node.exe>","<fake-ssh.mjs>"]' replaces the ssh
  // transport for remote commands (a .cmd stub can't be spawned without a shell
  // on Windows). The same argv is appended either way. Unset in production.
  const sshCmd = () => {
    if (env.FROZEN_SSH_CMD) {
      try {
        const a = JSON.parse(env.FROZEN_SSH_CMD);
        if (Array.isArray(a) && a.length) return a.map(String);
      } catch { /* fall through to real ssh */ }
    }
    return [sshBin()];
  };
  const clean = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  const lastLine = (s) =>
    clean(s)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/post-quantum|store now|openssh\.com\/pq|may need to be upgraded/i.test(l))
      .pop() || "";
  const sshBase = () => [
    "-i", cfg.sshKey,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=8",
    "-o", "LogLevel=ERROR",
  ];
  const sshRun = (command, timeoutMs) =>
    new Promise((resolve) => {
      const [bin, ...pre] = sshCmd();
      execFile(bin, [...pre, ...sshBase(), cfg.sshTarget, command], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
    });

  const portOpen = (port, ms = 800) =>
    new Promise((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port });
      const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(ms, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });

  const fail = (code, message) => Object.assign(new Error(message), { code });

  /* ── route: tunnel + LM Studio server ── */
  let tunnel = null; // { proc, stderr } — ONLY a tunnel this process spawned
  let routePromise = null;
  let lastServerStart = 0;
  let lastLoaded = [];
  let lastDownloaded = [];

  function readRemembered() {
    try {
      const v = JSON.parse(fs.readFileSync(cfg.modelsFile, "utf8"));
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  /** Remember the context each loaded model runs with, so a reload matches it. */
  function rememberLoaded(loaded) {
    if (!loaded.length) return;
    const cur = readRemembered();
    let changed = false;
    for (const m of loaded) {
      if (!m.contextLength || (cur[m.id] && cur[m.id].contextLength === m.contextLength)) continue;
      cur[m.id] = { contextLength: m.contextLength, seenAt: new Date().toISOString() };
      changed = true;
    }
    if (changed) {
      try { fs.writeFileSync(cfg.modelsFile, JSON.stringify(cur, null, 2)); } catch { /* best effort */ }
    }
  }

  let hermesCtxCache = { mtime: null, map: {} };
  function readHermesContexts() {
    try {
      const mtime = fs.statSync(cfg.hermesConfig).mtimeMs;
      if (hermesCtxCache.mtime !== mtime) {
        hermesCtxCache = { mtime, map: hermesConfigContexts(fs.readFileSync(cfg.hermesConfig, "utf8")) };
      }
    } catch {
      hermesCtxCache = { mtime: null, map: {} };
    }
    return hermesCtxCache.map;
  }
  /** Context to load `model` with (override > last run here > original Hermes' setting > 64K). */
  function contextFor(model) {
    return chooseLoadContext(model, readRemembered()[model.id], { override: cfg.loadContext, hermes: readHermesContexts()[model.id] });
  }

  async function probeLoaded() {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${cfg.localPort}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
    } catch (e) {
      throw fail("UNREACHABLE", e.cause?.code || e.message);
    }
    if (!res.ok) throw fail("HTTP", `LM Studio answered HTTP ${res.status}`);
    const payload = await res.json();
    const loaded = loadedModelsFrom(payload);
    lastLoaded = loaded;
    lastDownloaded = downloadedModelsFrom(payload);
    rememberLoaded(loaded);
    return loaded;
  }

  /**
   * Load a model on Frozen through the `lms` CLI (the REST load endpoint has no
   * TTL, which would pin the model forever). Called ONLY when a fresh probe,
   * taken while holding the Frozen slot, shows nothing loaded. Success is judged
   * by LM Studio's own model list, not the CLI's exit code.
   */
  async function loadModel(model, contextLength) {
    if (!isSafeModelId(model.id)) throw fail("BAD_ID", `refusing to pass an unusual model id to Frozen's shell: ${model.id}`);
    const cmd = lmsLoadCommand(model.id, contextLength, cfg.loadTtlSeconds);
    log(`frozen: loading ${model.id} ctx=${contextLength} ttl=${cfg.loadTtlSeconds}s (nothing was loaded on Frozen)`);
    const t0 = Date.now();
    const r = await sshRun(cmd, cfg.loadTimeoutMs);
    for (let i = 0; i < 20; i++) {
      let loaded = null;
      try { loaded = await probeLoaded(); } catch { /* retry */ }
      const hit = loaded && loaded.find((m) => m.id === model.id);
      if (hit) {
        log(`frozen: loaded ${model.id} ctx=${hit.contextLength} in ${((Date.now() - t0) / 1000).toFixed(1)}s (lms exit ${r.code})`);
        return hit;
      }
      if (r.code !== 0 && i >= 1) break; // the CLI said it failed and LM Studio agrees
      await sleep(1500);
    }
    const why = lastLine(r.stderr) || lastLine(r.stdout) || `lms exited with code ${r.code}`;
    log(`frozen: load of ${model.id} failed: ${why}`);
    throw fail("LOAD", why);
  }

  /**
   * Unload one chat model on Frozen. Called ONLY inside a user-confirmed swap,
   * after Frozen is idle. Verified against LM Studio's list, not the exit code.
   */
  async function unloadModel(id) {
    const cmd = lmsUnloadCommand(id);
    log(`frozen: unloading ${id} (user-confirmed swap)`);
    const r = await sshRun(cmd, 60_000);
    for (let i = 0; i < 20; i++) {
      let loaded = null;
      try { loaded = await probeLoaded(); } catch { /* retry */ }
      if (loaded && !loaded.some((m) => m.id === id)) {
        log(`frozen: unloaded ${id} (lms exit ${r.code})`);
        return;
      }
      await sleep(1000);
    }
    const why = lastLine(r.stderr) || lastLine(r.stdout) || `lms exited with code ${r.code}`;
    throw fail("UNLOAD", `${id} is still loaded after unload: ${why}`);
  }

  const tunnelAlive = () => !!(tunnel && tunnel.proc.exitCode === null);

  async function startTunnel() {
    if (!fs.existsSync(cfg.sshKey)) throw fail("NO_KEY", `SSH key for Frozen not found at ${cfg.sshKey}`);
    const args = [
      "-N", "-T", ...sshBase(),
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-L", `127.0.0.1:${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
      cfg.sshTarget,
    ];
    const proc = spawn(sshBin(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const rec = { proc, stderr: "" };
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => { rec.stderr = (rec.stderr + d).slice(-2000); });
    proc.on("exit", (code) => {
      if (tunnel === rec) tunnel = null;
      log(`frozen: tunnel pid=${proc.pid} exited code=${code}${rec.stderr ? " " + firstLine(rec.stderr) : ""}`);
    });
    tunnel = rec;
    log(`frozen: tunnel started pid=${proc.pid} 127.0.0.1:${cfg.localPort} -> ${cfg.sshTarget}:127.0.0.1:${cfg.remotePort}`);
    for (let i = 0; i < 40; i++) {
      if (proc.exitCode !== null) break;
      if (await portOpen(cfg.localPort, 400)) return;
      await sleep(250);
    }
    const why = firstLine(rec.stderr) || `ssh exited with code ${proc.exitCode}`;
    try { proc.kill(); } catch { /* ignore */ }
    throw fail("TUNNEL", `Could not open the SSH tunnel to Frozen (${cfg.sshTarget}): ${why}`);
  }

  async function doEnsureRoute() {
    try {
      return await probeLoaded();
    } catch (e) {
      if (e.code === "HTTP") throw fail("ROUTE", `Frozen's LM Studio is reachable but errored: ${e.message}`);
    }
    const portWasOpen = await portOpen(cfg.localPort);
    if (!portWasOpen) await startTunnel();
    try {
      return await probeLoaded();
    } catch { /* upstream refused through the tunnel — server probably not started */ }

    if (Date.now() - lastServerStart > 60_000) {
      lastServerStart = Date.now();
      log(`frozen: starting LM Studio API server on Frozen (loopback :${cfg.remotePort}) — the loaded model is not touched`);
      const r = await sshRun(`lms server start --bind 127.0.0.1 --port ${cfg.remotePort}`, 45_000);
      log(`frozen: lms server start -> code=${r.code} ${firstLine(r.stdout) || firstLine(r.stderr)}`);
      if (r.code !== 0 && !/running/i.test(r.stdout + r.stderr)) {
        throw fail("SERVER", `Couldn't start LM Studio's API server on Frozen: ${firstLine(r.stderr) || firstLine(r.stdout) || `ssh exit ${r.code}`}`);
      }
    }
    for (let i = 0; i < 12; i++) {
      try { return await probeLoaded(); } catch { /* retry */ }
      await sleep(1000);
    }
    if (portWasOpen && !tunnelAlive()) {
      throw fail("PORT_BUSY", `Port ${cfg.localPort} is held by another program that isn't forwarding to Frozen's LM Studio. Grok Build won't stop another app's process — free the port or set FROZEN_LOCAL_PORT.`);
    }
    throw fail("ROUTE", `Frozen's LM Studio API isn't answering through the tunnel. Is the Frozen PC on and LM Studio running?`);
  }

  function ensureRoute() {
    if (!routePromise) routePromise = doEnsureRoute().finally(() => { routePromise = null; });
    return routePromise;
  }

  /* ── Frozen's own queue: is ANY loaded model busy (Bionic, original Hermes, us)? ── */
  let busyCache = { at: 0, value: null };
  async function anyBusy() {
    if (Date.now() - busyCache.at < 2500) return busyCache.value;
    const r = await sshRun("lms ps --json", 12_000);
    let value = null; // null = unknown → don't block on it
    try {
      const arr = JSON.parse(r.stdout);
      const busy = arr.filter((x) => x.type !== "embedding" && (String(x.status || "") !== "idle" || Number(x.queued || 0) > 0));
      value = busy.length
        ? { busy: true, detail: busy.map((x) => `${x.identifier}: ${x.status}${x.queued ? `, ${x.queued} queued` : ""}`).join("; ") }
        : { busy: false, detail: "" };
    } catch { /* unknown */ }
    busyCache = { at: Date.now(), value };
    return value;
  }
  /** Block until Frozen is idle (or cancelled / out of patience). Returns null when clear, else a result to return. */
  async function waitIdle(hooks, what) {
    const t0 = Date.now();
    let announced = false;
    for (;;) {
      const b = await anyBusy().catch(() => null);
      if (!b || !b.busy) return null;
      if (!announced) {
        hooks.onStatus(`Waiting for Frozen before ${what} — a model is busy (${b.detail}), probably Bionic.\n`);
        announced = true;
      }
      if (hooks.isCancelled()) return { status: "interrupted" };
      if (Date.now() - t0 > cfg.busyMaxWaitMs) {
        return { status: "error", note: `⚠️ Frozen stayed busy for over ${Math.round(cfg.busyMaxWaitMs / 60000)} minutes, so this turn was not sent. Try again when Bionic is done.` };
      }
      await sleep(3000);
      busyCache.at = 0;
    }
  }

  /* ── the Hermes profile (versioned in the repo, synced into the data dir) ── */
  function syncProfile(model) {
    fs.mkdirSync(cfg.hermesHome, { recursive: true });
    const srcPlugins = path.join(repoDir, "hermes-profile", "plugins");
    if (fs.existsSync(srcPlugins)) {
      for (const name of fs.readdirSync(srcPlugins)) {
        const src = path.join(srcPlugins, name);
        const dst = path.join(cfg.hermesHome, "plugins", name);
        fs.mkdirSync(dst, { recursive: true });
        for (const f of fs.readdirSync(src)) {
          const a = path.join(src, f), b = path.join(dst, f);
          if (!fs.statSync(a).isFile()) continue;
          const want = fs.readFileSync(a);
          if (!fs.existsSync(b) || !fs.readFileSync(b).equals(want)) fs.writeFileSync(b, want);
        }
      }
    }
    const cfgPath = path.join(cfg.hermesHome, "config.yaml");
    const current = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
    let next = upsertModelBlock(current, {
      provider: "lmstudio",
      default: model,
      base_url: baseUrl,
      context_length: String((lastLoaded.find((m) => m.id === model) || {}).contextLength || 143360),
      lmstudio_load_mode: "jit",
    });
    if (!/^plugins:/m.test(next)) next = next.replace(/\n*$/, "\n") + "plugins:\n  enabled:\n    - grok-deny-mirror\n  disabled: []\n";
    if (next !== current) {
      fs.writeFileSync(cfgPath, next, "utf8");
      return true; // profile changed — a running bridge must restart to pick it up
    }
    return false;
  }

  /* ── the Hermes ACP bridge (one long-lived process) ── */
  let bridge = null;
  let bridgeModel = null;

  function startBridge(model) {
    if (!fs.existsSync(cfg.hermesExe)) {
      throw fail("NO_HERMES", `The Hermes agent isn't installed where expected (${cfg.hermesExe}).`);
    }
    const child = spawn(cfg.hermesExe, ["acp"], {
      cwd: defaultCwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...env,
        HERMES_HOME: cfg.hermesHome,
        LM_BASE_URL: baseUrl,
        LM_API_KEY: "lm-studio-local", // non-secret placeholder; Frozen's server is loopback-only and unauthenticated
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    // sessionModels: Hermes session id -> the model Hermes has that session BOUND
    // to (from its own currentModelId). A resumed session keeps the model it was
    // created with, regardless of the profile default, so this — not the chat's
    // setting — is what decides whether a session is safe to prompt.
    const rec = { child, handlers: new Map(), sessionModels: new Map(), stderr: "", model };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { rec.stderr = (rec.stderr + d).slice(-6000); });
    child.on("exit", (code) => {
      log(`frozen: hermes acp pid=${child.pid} exited code=${code}`);
      if (bridge === rec) { bridge = null; bridgeModel = null; }
      const tail = rec.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
      for (const h of rec.handlers.values()) h.onBridgeExit?.(code, tail);
      rec.handlers.clear();
    });
    rec.conn = new acp.ClientSideConnection(
      () => ({
        async sessionUpdate(p) {
          const h = rec.handlers.get(p.sessionId);
          if (h) h.onUpdate(p.update);
        },
        async requestPermission(p) {
          const h = rec.handlers.get(p.sessionId);
          return h ? h.onPermission(p) : { outcome: { outcome: "cancelled" } };
        },
      }),
      acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    );
    const died = new Promise((_, reject) =>
      child.once("exit", (code) => reject(fail("BRIDGE", `Hermes exited during startup (code ${code}): ${rec.stderr.trim().split(/\r?\n/).slice(-2).join(" | ")}`)))
    );
    rec.ready = Promise.race([
      rec.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      died,
    ]).then((init) => {
      log(`frozen: hermes acp ready pid=${child.pid} protocol=${init.protocolVersion} model=${model}`);
      return rec;
    });
    rec.ready.catch(() => { /* surfaced to the caller */ });
    bridge = rec;
    bridgeModel = model;
    return rec;
  }

  async function getBridge(model) {
    const changed = syncProfile(model);
    if (bridge && bridge.child.exitCode === null && (changed || bridgeModel !== model)) {
      // Loaded model changed (e.g. Bionic swapped it) — restart so Hermes asks for the loaded one.
      if (bridge.handlers.size === 0) {
        log(`frozen: profile changed (model ${bridgeModel} -> ${model}) — restarting hermes acp`);
        try { bridge.child.kill(); } catch { /* ignore */ }
        bridge = null;
      }
    }
    if (!bridge || bridge.child.exitCode !== null) startBridge(model);
    return bridge.ready;
  }

  /* ── one Frozen request at a time, gateway-wide ── */
  let slotTail = Promise.resolve();
  let slotHolder = null;
  function acquireSlot(label) {
    let release;
    const mine = new Promise((r) => { release = r; });
    const prev = slotTail;
    slotTail = prev.then(() => mine);
    const waitingOn = slotHolder;
    const acquired = prev.then(() => {
      slotHolder = label;
      return () => { if (slotHolder === label) slotHolder = null; release(); };
    });
    return { acquired, waitingOn };
  }

  /* ── public surface used by server.mjs ── */
  return {
    SLUG: LOCAL_SLUG,
    LABEL: LOCAL_LABEL,
    cfg,

    /** Loaded models (cached result when the route is down, marked unavailable). */
    async inventory(budgetMs = 4000) {
      try {
        const loaded = await Promise.race([ensureRoute(), sleep(budgetMs).then(() => { throw fail("TIMEOUT", "Frozen didn't answer in time"); })]);
        // Same list original Hermes shows: EVERY chat model downloaded on Frozen,
        // read live from LM Studio (no hand-written list). Loaded ones first.
        const loadedIds = new Set(loaded.map((m) => m.id));
        const rest = lastDownloaded
          .filter((m) => !loadedIds.has(m.id))
          .map((m) => ({ id: m.id, contextLength: contextFor(m), maxContextLength: m.maxContextLength, type: m.type, toolUse: m.toolUse, loaded: false }));
        const models = [...loaded.map((m) => ({ ...m, loaded: true })), ...rest];
        const notes = [];
        if (!loaded.length) {
          notes.push("Nothing is loaded on Frozen right now (LM Studio unloads idle models after an hour). Your first message loads the model you pick — about a minute.");
        } else {
          notes.push(`Loaded now: ${loaded.map((m) => m.id).join(", ")}. Picking a different model asks you to confirm replacing it.`);
          for (const m of loaded) {
            const a = assessModel(m);
            if (a.refuse) notes.push(a.refuse);
            notes.push(...a.warn);
          }
        }
        return { ok: true, models, warning: notes.join(" ") };
      } catch (e) {
        return { ok: false, models: lastLoaded, warning: `Frozen unavailable: ${e.message}` };
      }
    },

    isLoaded(model) {
      return lastLoaded.some((m) => m.id === model);
    },

    /**
     * Can a chat select `model` right now? Same rules a turn applies.
     *   { ok:true, willLoad, swapToken? }        — selection accepted
     *   { ok:false, confirm:{ message } }        — a loaded model would be replaced; ask first
     *   { ok:false, code, reason }               — refused
     * `confirmed` is the desktop's re-send after its Confirm dialog.
     */
    async checkSelectable(model, { confirmed = false, budgetMs = 6000 } = {}) {
      let loaded;
      try {
        loaded = await Promise.race([ensureRoute(), sleep(budgetMs).then(() => { throw fail("TIMEOUT", "Frozen didn't answer in time"); })]);
      } catch (e) {
        return { ok: false, code: 4041, reason: `Frozen unavailable: ${e.message}` };
      }
      const plan = planModel(model, { loaded, downloaded: lastDownloaded });
      if (plan.action === "not-downloaded") return { ok: false, code: 4041, reason: planRefusal(plan, model) };
      if (plan.action !== "use" && !isSafeModelId(model)) {
        return { ok: false, code: 4041, reason: `${model} has an unusual name, so Grok Build won't load it on Frozen.` };
      }
      const def = plan.action === "use" ? plan.model : lastDownloaded.find((m) => m.id === model);
      const probe = plan.action === "use" ? plan.model : { ...def, contextLength: contextFor(def) };
      const verdict = assessModel(probe);
      if (verdict.refuse) return { ok: false, code: 4042, reason: verdict.refuse };
      if (plan.action === "other-loaded") {
        const replacing = plan.loaded.map((m) => m.id);
        if (!confirmed) return { ok: false, confirm: { message: swapConfirmMessage(model, replacing) } };
        return { ok: true, willLoad: true, swapToken: { to: model, replacing, at: Date.now() } };
      }
      return { ok: true, willLoad: plan.action === "load" };
    },

    /**
     * Run one visible turn. `hooks` = { onEvent(type,payload), onText(t), onReasoning(t),
     * onStatus(text), isCancelled() }. Resolves { status, note?, usage }.
     */
    /** Record a model's context (used to seed a known-good value). */
    remember(id, contextLength) {
      rememberLoaded([{ id, contextLength }]);
    },

    async runTurn(session, text, hooks) {
      const label = `${session.id.slice(0, 8)}-${Date.now()}`;
      const state = { tools: new Map(), seq: 0, contextUsed: null, contextSize: null };
      const settle = (error) => { for (const e of settleOpenTools(state, error)) hooks.onEvent(e.type, e.payload); };

      // 1) route + model guard (before taking the slot — a dead route shouldn't queue behind others)
      let loaded;
      try {
        loaded = await ensureRoute();
      } catch (e) {
        return { status: "error", note: `⚠️ Frozen Local is unavailable: ${e.message} (No cloud fallback — pick Grok from the model menu to use your subscription instead.)` };
      }
      // Cheap early refusal (no slot needed) when Frozen clearly can't serve this chat.
      {
        const p0 = planModel(session.model, { loaded, downloaded: lastDownloaded });
        const swap0 = swapDecision(p0, session.model, session.local_swap_ok);
        if (p0.action === "not-downloaded" || (p0.action === "other-loaded" && !swap0.allowed)) {
          return { status: "error", note: `⚠️ ${planRefusal(p0, session.model)}` };
        }
      }

      // 2) one request at a time across the whole gateway
      const slot = acquireSlot(label);
      if (slot.waitingOn) hooks.onStatus(`Waiting for another Frozen Local chat to finish — Frozen serves one request at a time.\n`);
      const release = await slot.acquired;
      try {
        if (hooks.isCancelled()) return { status: "interrupted" };

        // 2b) re-check UNDER the slot — Bionic may have loaded or unloaded something
        // while we waited. Loading is only ever decided from this fresh look.
        let fresh;
        try {
          fresh = await probeLoaded();
        } catch (e) {
          return { status: "error", note: `⚠️ Frozen Local is unavailable: ${e.message}` };
        }
        const plan = planModel(session.model, { loaded: fresh, downloaded: lastDownloaded });
        if (plan.action === "not-downloaded") return { status: "error", note: `⚠️ ${planRefusal(plan, session.model)}` };

        let loadedModel = plan.model;
        if (plan.action !== "use") {
          const def = lastDownloaded.find((m) => m.id === session.model);
          const ctx = contextFor(def);
          const pre = assessModel({ ...def, contextLength: ctx });
          if (pre.refuse) return { status: "error", note: `⚠️ ${pre.refuse}` };

          if (plan.action === "other-loaded") {
            // A swap needs the token earned in the model menu, and Frozen must
            // still hold exactly what that confirm was about (Bionic race).
            const swap = swapDecision(plan, session.model, session.local_swap_ok);
            if (!swap.allowed) return { status: "error", note: `⚠️ ${planRefusal(plan, session.model)}` };
            // Never pull a model out from under a running request.
            const wait = await waitIdle(hooks, `replacing ${swap.replacing.join(", ")}`);
            if (wait) return wait;
            hooks.onStatus(`Unloading ${swap.replacing.join(", ")} on Frozen (you confirmed this swap), then loading \`${session.model}\` with ${ctx.toLocaleString("en-US")} context — about a minute.\n`);
            try {
              for (const id of swap.replacing) await unloadModel(id);
            } catch (e) {
              return { status: "error", note: `⚠️ Couldn't unload on Frozen: ${e.message}. Nothing was sent to the model.` };
            }
            delete session.local_swap_ok; // one confirm = one swap
          } else {
            hooks.onStatus(
              `Loading \`${session.model}\` on Frozen with ${ctx.toLocaleString("en-US")} context — nothing was loaded ` +
                `(LM Studio unloads idle models after an hour). This takes about a minute.\n`
            );
          }
          try {
            loadedModel = await loadModel(def, ctx);
          } catch (e) {
            return { status: "error", note: `⚠️ Couldn't load \`${session.model}\` on Frozen: ${e.message}. Nothing was sent to the model.` };
          }
          busyCache.at = 0;
          if (hooks.isCancelled()) return { status: "interrupted" };
        }
        const assessment = assessModel(loadedModel);
        if (assessment.refuse) return { status: "error", note: `⚠️ ${assessment.refuse}` };

        // 3) respect Bionic: wait while Frozen's own queue is busy
        {
          const wait = await waitIdle(hooks, "your turn");
          if (wait) return wait;
        }

        // 4) Hermes session (resume the provider's own session id; never Grok's)
        let b;
        try {
          b = await getBridge(session.model);
        } catch (e) {
          return { status: "error", note: `⚠️ Couldn't start the local Hermes agent: ${e.message}` };
        }
        // One Hermes session per (chat, model). A Hermes session stays bound to
        // the model it was created with — its restore path rebuilds the agent
        // from the STORED model, not the profile default — so reusing a chat's
        // session after a model swap would make Hermes request the OLD model,
        // and LM Studio would JIT-load it and evict Bionic's. (Reproduced with
        // scripts/frozen-local-swap-e2e.mjs before this fix.) Switching back to
        // a model resumes that model's own session, history included.
        session.local_session_ids = session.local_session_ids || {};
        const ids = session.local_session_ids;
        const key = `${LOCAL_SLUG}:${session.model}`;
        let candidate = ids[key] || null;
        const legacy = !candidate && !!ids[LOCAL_SLUG]; // pre-fix format: model unknown, must be verified
        if (legacy) candidate = ids[LOCAL_SLUG];
        const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : defaultCwd;
        let acpSessionId = null;

        if (candidate) {
          const known = b.sessionModels.get(candidate);
          if (known === session.model) {
            acpSessionId = candidate; // already open in this Hermes process, on the right model
          } else if (known === undefined) {
            try {
              // Resume replays the session's history as session/update events BEFORE it
              // returns. No handler is registered for this session yet, so that replay is
              // dropped rather than re-streamed into the chat — keep it that way.
              const r = await b.conn.resumeSession({ sessionId: candidate, cwd, mcpServers: [] });
              const bound = modelFromChoice(r && r.models && r.models.currentModelId);
              b.sessionModels.set(candidate, bound);
              if (bound === session.model) {
                acpSessionId = candidate;
                log(`frozen: resumed hermes session ${candidate.slice(0, 8)} for chat ${session.id.slice(0, 8)} model=${bound}`);
              } else {
                log(`frozen: hermes session ${candidate.slice(0, 8)} is bound to ${bound || "an unknown model"}, not ${session.model} — not using it (it would request a model that isn't loaded)`);
              }
            } catch (e) {
              log(`frozen: resume ${candidate.slice(0, 8)} failed (${e.message})`);
            }
          } else {
            log(`frozen: hermes session ${candidate.slice(0, 8)} is bound to ${known}, not ${session.model} — not using it`);
          }
          if (legacy) {
            delete ids[LOCAL_SLUG];
            if (acpSessionId) ids[key] = acpSessionId;
          }
        }

        if (!acpSessionId) {
          const created = await b.conn.newSession({ cwd, mcpServers: [] });
          const bound = modelFromChoice(created.models && created.models.currentModelId);
          b.sessionModels.set(created.sessionId, bound);
          if (bound !== session.model) {
            // Never prompt a session that isn't on the loaded model — that is the
            // exact request that would make LM Studio load something else.
            log(`frozen: new hermes session came up on ${bound || "an unknown model"}, expected ${session.model} — turn NOT sent`);
            return { status: "error", note: `⚠️ The local agent started on ${bound || "an unknown model"} instead of \`${session.model}\`, so this turn was not sent (it would have asked Frozen to load a model that isn't loaded). Try again; if it repeats, restart Grok Build.` };
          }
          acpSessionId = created.sessionId;
          ids[key] = acpSessionId;
          log(`frozen: new hermes session ${acpSessionId.slice(0, 8)} for chat ${session.id.slice(0, 8)} model=${bound} cwd=${cwd}`);
        }

        // Heads-up (once per chat per model) for a model that works but has caveats.
        session.local_warned = session.local_warned || {};
        if (assessment.warn.length && !session.local_warned[session.model]) {
          session.local_warned[session.model] = true;
          hooks.onStatus(`Heads-up: ${assessment.warn.join(" ")}\n`);
        }

        // 5) the turn
        let bridgeExit = null;
        let cancelSent = false;
        const sendCancel = () => {
          if (cancelSent) return;
          cancelSent = true;
          b.conn.cancel({ sessionId: acpSessionId }).catch(() => { /* ignore */ });
        };
        b.handlers.set(acpSessionId, {
          onUpdate: (u) => {
            for (const e of mapAcpUpdate(u, state, session.id)) {
              if (e.text) hooks.onText(e.text);
              if (e.reasoning) hooks.onReasoning(e.reasoning);
              hooks.onEvent(e.type, e.payload);
            }
          },
          onPermission: async (p) => {
            const title = (p.toolCall && p.toolCall.title) || "tool call";
            const decision = choosePermission(p.options, cfg.approvals);
            log(`frozen: permission "${String(title).slice(0, 80)}" -> ${decision.outcome.optionId || decision.outcome.outcome} (policy=${cfg.approvals})`);
            return decision;
          },
          onBridgeExit: (code, tail) => { bridgeExit = { code, tail }; },
        });
        const cancelPoll = setInterval(() => { if (hooks.isCancelled()) sendCancel(); }, 250);
        try {
          const res = await b.conn.prompt({ sessionId: acpSessionId, prompt: [{ type: "text", text }] });
          settle(res.stopReason === "cancelled" ? "cancelled" : null);
          const usage = state.contextUsed != null ? { context_used: state.contextUsed, context_size: state.contextSize } : null;
          if (res.stopReason === "cancelled" || hooks.isCancelled()) return { status: "interrupted", usage };
          if (res.stopReason === "max_tokens") return { status: "complete", usage, note: "⚠️ The local model hit its output limit — send a follow-up to continue." };
          if (res.stopReason === "max_turn_requests") return { status: "complete", usage, note: "⚠️ The local agent hit its tool-round limit for this turn — send a follow-up to continue." };
          return { status: "complete", usage };
        } catch (e) {
          settle("error");
          if (hooks.isCancelled()) return { status: "interrupted" };
          if (bridgeExit) {
            return { status: "error", note: `⚠️ The local Hermes agent stopped mid-turn (exit ${bridgeExit.code}). ${bridgeExit.tail || ""} Completed tool steps above are not re-run; send your message again to retry.` };
          }
          return { status: "error", note: `⚠️ Frozen Local turn failed: ${e.message || e}. Completed tool steps above are not re-run.` };
        } finally {
          clearInterval(cancelPoll);
          if (b.handlers.get(acpSessionId)) b.handlers.delete(acpSessionId);
        }
      } finally {
        release();
      }
    },

    status() {
      return {
        tunnelPid: tunnelAlive() ? tunnel.proc.pid : null,
        bridgePid: bridge && bridge.child.exitCode === null ? bridge.child.pid : null,
        loaded: lastLoaded.map((m) => m.id),
        slotHolder,
      };
    },

    /**
     * Kill just the Hermes agent process (a wedged turn that ignored cancel).
     * Its exit handler fails the in-flight prompt, which releases Frozen's slot.
     * The tunnel and everything on Frozen are left alone; the next turn respawns
     * Hermes and resumes the chat's own session id.
     */
    shutdownBridge() {
      if (bridge && bridge.child.exitCode === null) { try { bridge.child.kill(); } catch { /* ignore */ } }
    },

    /** Stop only what THIS process owns. Frozen's LM Studio server and model are never stopped. */
    shutdown() {
      if (bridge && bridge.child.exitCode === null) { try { bridge.child.kill(); } catch { /* ignore */ } }
      if (tunnelAlive()) { try { tunnel.proc.kill(); } catch { /* ignore */ } }
    },
  };
}
