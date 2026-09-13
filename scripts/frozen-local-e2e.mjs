/* Frozen Local — live end-to-end test against a THROWAWAY gateway instance.
 *
 *   node scripts/frozen-local-e2e.mjs
 *
 * Spawns its own gateway on GW_PORT (default 8797) with a fresh temp
 * GROK_GATEWAY_HOME, so the production gateway on 8787 and its sessions are
 * never touched, and the Hermes profile is rebuilt from hermes-profile/.
 * Needs: Frozen reachable over SSH with a model loaded, Hermes installed, and a
 * logged-in Grok account (one tiny Grok turn proves that path still works).
 *
 * Asserts the acceptance list: picker + selection, no-JIT-load guard, a real
 * tool turn, Grok's deny list enforced ON DISK, Stop, resume across a gateway
 * restart, the Grok path intact, and Frozen's loaded model unchanged.
 * Exit 0 = pass. */
import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const PORT = Number(process.env.GW_PORT || 8797);
const TOKEN = "frozen-e2e-token";
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-e2e-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-e2e-work-"));
for (const f of ["alpha.txt", "beta.txt", "gamma.txt"]) fs.writeFileSync(path.join(work, f), f);
const denyProbeDir = path.join(os.homedir(), ".claude", "skills", "__frozen_deny_probe__");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Frozen snapshot (read-only) ── */
function frozenSnapshot() {
  const key = path.join(os.homedir(), ".ssh", "frozen_rgb_control_ed25519");
  return new Promise((resolve) => {
    execFile("ssh", ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", process.env.FROZEN_SSH_TARGET || "anyae@192.168.50.140", "lms ps --json"],
      { windowsHide: true, timeout: 20000 }, (e, out) => {
        try { resolve(JSON.parse(out).map((m) => `${m.identifier}@${m.contextLength}`).sort().join(",")); } catch { resolve(null); }
      });
  });
}

/* ── gateway lifecycle ── */
let gw = null;
function startGateway() {
  gw = spawn(process.execPath, [path.join(repo, "server.mjs")], {
    cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GROK_GATEWAY_PORT: String(PORT), GROK_GATEWAY_TOKEN: TOKEN, GROK_GATEWAY_HOME: home },
  });
  gw.stdout.resume(); gw.stderr.resume();
  return waitHealthy();
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true; } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("test gateway did not become healthy");
}
function killGatewayTree() {
  if (!gw || gw.exitCode !== null) return;
  // Tree kill: the gateway's own ssh tunnel + hermes acp are its children.
  try { execFileSync("taskkill", ["/T", "/F", "/PID", String(gw.pid)], { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
}

/* ── WS client ── */
class Client {
  constructor() { this.seq = 0; this.pending = new Map(); this.events = []; this.waiters = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/ws?token=${TOKEN}`);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : res(msg.result);
        } else if (msg.method === "event") {
          this.events.push(msg.params);
          for (const w of [...this.waiters]) if (w.pred(msg.params)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(msg.params); }
        }
      });
    });
  }
  rpc(method, params = {}, timeout = 60000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method} timed out`)); }, timeout);
    });
  }
  waitEvent(pred, timeout = 300000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error("event wait timed out")); } }, timeout);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** Submit a prompt and collect that turn's events until message.complete. */
async function turn(c, sid, text, { timeout = 360000, onFirstDelta } = {}) {
  const from = c.events.length;
  await c.rpc("prompt.submit", { session_id: sid, text });
  let fired = false;
  const deltaWatch = onFirstDelta
    ? (async () => {
        await c.waitEvent((e) => c.events.indexOf(e) >= from && e.session_id === sid && (e.type === "message.delta" || e.type === "reasoning.delta"), timeout);
        fired = true;
        await onFirstDelta();
      })().catch(() => {})
    : null;
  const done = await c.waitEvent((e) => c.events.indexOf(e) >= from && e.session_id === sid && e.type === "message.complete", timeout);
  if (deltaWatch && !fired) await Promise.race([deltaWatch, sleep(10)]);
  const evs = c.events.slice(from).filter((e) => e.session_id === sid);
  return { done: done.payload, evs, types: evs.map((e) => e.type) };
}

(async () => {
  const before = await frozenSnapshot();
  console.log(`Frozen before: ${before}`);
  const LOADED = before ? before.split(",")[0].split("@")[0] : null;
  if (!LOADED) { console.error("Frozen unreachable or nothing loaded — cannot run the live test."); process.exit(2); }

  console.log(`test gateway :${PORT} home=${home}`);
  await startGateway();
  let c = new Client();
  await c.open();

  /* 1. catalog */
  const opts0 = await c.rpc("model.options", {}, 90000);
  const frozenRow0 = opts0.providers.find((p) => p.slug === "frozen-local");
  ok("model.options lists a Frozen Local provider", !!frozenRow0, JSON.stringify(opts0.providers.map((p) => p.slug)));
  ok("Frozen row offers the loaded model", !!frozenRow0 && frozenRow0.models.includes(LOADED), frozenRow0 && JSON.stringify(frozenRow0));
  ok("Grok stays current when no chat is selected", opts0.providers.find((p) => p.slug === "grok-cli")?.is_current === true);
  // The Hermes profile is built LAZILY at the first Frozen turn (nothing is
  // written to disk just because the picker opened), so it must NOT exist yet.
  const hermesProfile = path.join(home, "hermes-local");
  ok("opening the picker writes no Hermes profile (lazy by design)", !fs.existsSync(path.join(hermesProfile, "config.yaml")));

  /* 2. global default can't be flipped to local */
  const setGlobal = await fetch(`${BASE}/api/model/set`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hermes-Session-Token": TOKEN }, body: JSON.stringify({ scope: "main", provider: "frozen-local", model: LOADED }) });
  ok("global /api/model/set refuses Frozen Local with a 4xx (Grok stays default)", setGlobal.status >= 400 && setGlobal.status < 500, `HTTP ${setGlobal.status}`);

  /* 3. per-chat selection */
  const created = await c.rpc("session.create", { cwd: work });
  const sid = created.session_id;
  ok("new chat defaults to Grok", created.info.provider === "grok-cli");
  const refused = await c.rpc("config.set", { session_id: sid, key: "model", value: "google/gemma-4-31b --provider frozen-local --session" }).then(() => null, (e) => e);
  ok("switching to a NOT-loaded Frozen model is refused (no JIT load)", refused && refused.code === 4041, refused ? refused.message : "accepted");
  const switched = await c.rpc("config.set", { session_id: sid, key: "model", value: `${LOADED} --provider frozen-local --session` }, 90000);
  ok("switching to the loaded Frozen model is accepted", switched && !switched.deferred);
  const info = await c.waitEvent((e) => e.session_id === sid && e.type === "session.info" && e.payload.provider === "frozen-local", 15000).catch(() => null);
  ok("session.info confirms provider frozen-local", !!info);
  const opts1 = await c.rpc("model.options", { session_id: sid }, 90000);
  ok("chat-scoped model.options marks Frozen current, Grok not", opts1.providers.find((p) => p.slug === "frozen-local")?.is_current === true && opts1.providers.find((p) => p.slug === "grok-cli")?.is_current === false);
  ok("other config.set keys keep their old behavior", (await c.rpc("config.set", { session_id: sid, key: "reasoning", value: "high" }))?.ok === true);

  /* 4. real tool turn */
  const t1 = await turn(c, sid, `Use your tools to list the files in ${work} and tell me how many there are and their names. Be brief.`);
  ok("tool turn completes", t1.done.status === "complete", `status=${t1.done.status} text=${String(t1.done.text).slice(0, 200)}`);
  ok("stream opened with message.start", t1.types.includes("message.start"));
  ok("tool chips: tool.start and tool.complete", t1.types.includes("tool.start") && t1.types.includes("tool.complete"), JSON.stringify([...new Set(t1.types)]));
  ok("answer streamed as message.delta", t1.types.includes("message.delta"));
  ok("answer is correct (3 files, named)", /\b(3|three)\b/i.test(t1.done.text) && /alpha/i.test(t1.done.text), String(t1.done.text).slice(0, 200));
  const profCfg = path.join(hermesProfile, "config.yaml");
  ok("first Frozen turn rebuilt the profile from the repo (config + deny-mirror plugin)",
    fs.existsSync(profCfg) && fs.existsSync(path.join(hermesProfile, "plugins", "grok-deny-mirror", "__init__.py")));
  const profText = fs.existsSync(profCfg) ? fs.readFileSync(profCfg, "utf8") : "";
  ok("profile runs jit mode (no model preload on shared Frozen)", /lmstudio_load_mode: jit/.test(profText));
  ok("profile pins the loaded model + tunnel URL", profText.includes(`default: ${LOADED}`) && profText.includes("base_url: http://127.0.0.1:12345/v1"));
  ok("profile enables the deny-mirror plugin", /enabled:\s*\n\s+- grok-deny-mirror/.test(profText));

  /* 5. Grok's deny list, verified on disk */
  fs.rmSync(denyProbeDir, { recursive: true, force: true });
  const t2 = await turn(c, sid, `Using your write_file tool, create the file ${path.join(denyProbeDir, "probe.md")} containing the word hello. If a tool refuses, say so and stop.`);
  ok("deny turn settles (no hang)", ["complete", "error"].includes(t2.done.status), `status=${t2.done.status}`);
  ok("PROTECTED PATH NOT WRITTEN (deny-mirror enforced on disk)", !fs.existsSync(path.join(denyProbeDir, "probe.md")) && !fs.existsSync(denyProbeDir));
  console.log(`       model said: ${String(t2.done.text).replace(/\s+/g, " ").slice(0, 160)}`);

  /* 6. Stop */
  const t3 = await turn(c, sid, "Count from 1 to 400, one number per line. Do not use any tools.", {
    onFirstDelta: async () => { await sleep(1500); await c.rpc("session.interrupt", { session_id: sid }); },
    timeout: 240000,
  });
  ok("Stop settles the turn as interrupted", t3.done.status === "interrupted", `status=${t3.done.status}`);
  ok("interrupted turn still ends with visible text", String(t3.done.text || "").trim().length > 0);

  /* 7. resume across a gateway restart */
  c.close();
  killGatewayTree();
  await sleep(1500);
  await startGateway();
  c = new Client();
  await c.open();
  const resumed = await c.rpc("session.resume", { session_id: sid });
  ok("chat still on Frozen Local after gateway restart", resumed.info.provider === "frozen-local");
  const t4 = await turn(c, sid, "What directory did I ask you to list files in earlier in this chat? Answer in one short sentence.");
  ok("resumed chat remembers earlier context", t4.done.status === "complete" && (t4.done.text.includes(path.basename(work)) || /frozen-e2e-work/i.test(t4.done.text)), String(t4.done.text).slice(0, 200));

  /* 8. Grok path untouched */
  const g = await c.rpc("session.create", { cwd: work });
  const tg = await turn(c, g.session_id, "Reply with exactly the token GROK-PATH-OK and nothing else.", { timeout: 240000 });
  ok("Grok path still answers", tg.done.status === "complete" && /GROK-PATH-OK/.test(tg.done.text), `status=${tg.done.status} text=${String(tg.done.text).slice(0, 160)}`);

  /* 9. Frozen untouched */
  const after = await frozenSnapshot();
  console.log(`Frozen after:  ${after}`);
  ok("Frozen's loaded model + context unchanged", before === after, `${before} vs ${after}`);

  c.close();
  killGatewayTree();
  fs.rmSync(denyProbeDir, { recursive: true, force: true });
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("E2E ERROR:", e.message || e);
  killGatewayTree();
  process.exit(2);
});
