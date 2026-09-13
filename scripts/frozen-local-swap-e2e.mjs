/* Frozen Local — MODEL SWAP end-to-end test. Never touches the real Frozen PC.
 *
 *   node scripts/frozen-local-swap-e2e.mjs
 *
 * The question it answers: "If Bionic loads a different model in LM Studio, does
 * Grok Hermes just work — and never ask LM Studio for a model that isn't
 * loaded?" Asking for an unloaded model makes real LM Studio JIT-load it and
 * evict whatever Bionic is using. So the core assertion is on the MOCK's request
 * log: after a swap, not one completion may name a model that wasn't loaded.
 *
 * Runs a throwaway gateway (fresh GROK_GATEWAY_HOME) pointed at a mock LM Studio
 * (scripts/mock-lmstudio.mjs); SSH goes to a dead address so Frozen is never
 * contacted. Uses the real installed Hermes agent. Exit 0 = pass. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startMockLmStudio } from "./mock-lmstudio.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const PORT = Number(process.env.GW_PORT || 8798);
const TOKEN = "frozen-swap-e2e-token";
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-swap-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-swap-work-"));

const A = { id: "mock/model-alpha", ctx: 131072 };
const B = { id: "mock/model-bravo", ctx: 131072 };
const TINY = { id: "mock/model-tiny-ctx", ctx: 4096 };
const NOTOOLS = { id: "mock/model-no-tools", ctx: 131072, toolUse: false };

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${extra ? "  -> " + extra : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let gw = null;
function killGatewayTree() {
  if (!gw || gw.exitCode !== null) return;
  try { execFileSync("taskkill", ["/T", "/F", "/PID", String(gw.pid)], { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
}

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
  waitEvent(pred, timeout) {
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error("event wait timed out")); } }, timeout);
    });
  }
}

async function turn(c, sid, text, timeout = 240000) {
  const doneP = c.waitEvent((e) => e.session_id === sid && e.type === "message.complete", timeout);
  await c.rpc("prompt.submit", { session_id: sid, text });
  return (await doneP).payload;
}
const pick = (c, sid, model) => c.rpc("config.set", { session_id: sid, key: "model", value: `${model} --provider frozen-local --session` }, 30000);

/** Wait until the mock has seen no new completion for `quietMs` (Hermes background work settled). */
async function quiesce(mock, quietMs = 4000, maxMs = 60000) {
  const t0 = Date.now();
  let last = mock.completions.length, since = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(500);
    if (mock.completions.length !== last) { last = mock.completions.length; since = Date.now(); }
    else if (Date.now() - since >= quietMs) return;
  }
}

(async () => {
  const mock = await startMockLmStudio({ loaded: [A], downloaded: [A, B, TINY, NOTOOLS] });
  console.log(`mock LM Studio :${mock.port}   test gateway :${PORT}`);

  gw = spawn(process.execPath, [path.join(repo, "server.mjs")], {
    cwd: repo, windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      GROK_GATEWAY_PORT: String(PORT), GROK_GATEWAY_TOKEN: TOKEN, GROK_GATEWAY_HOME: home,
      FROZEN_LOCAL_PORT: String(mock.port),
      FROZEN_SSH_TARGET: "nobody@127.0.0.1", // dead on purpose: Frozen is never contacted
    },
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* retry */ }
    await sleep(500);
  }
  const c = new Client();
  await c.open();

  /* 1. start a chat on model A */
  const sid = (await c.rpc("session.create", { cwd: work })).session_id;
  await pick(c, sid, A.id);
  const t1 = await turn(c, sid, "Remember the word PINEAPPLE. Reply briefly.");
  ok("turn on model A completes", t1.status === "complete", `status=${t1.status} text=${String(t1.text).slice(0, 160)}`);
  ok("turn on model A asked the mock for model A", mock.completions.some((r) => r.model === A.id), JSON.stringify(mock.completions.map((r) => r.model)));
  await quiesce(mock);

  /* 2. Bionic swaps: A unloaded, B loaded */
  mock.setLoaded([B]);
  const swapIndex = mock.completions.length;
  console.log(`  -- simulated swap: loaded is now [${B.id}] (completions so far: ${swapIndex})`);

  const opts = await c.rpc("model.options", { session_id: sid }, 30000);
  const row = opts.providers.find((p) => p.slug === "frozen-local");
  ok("picker now offers ONLY the newly loaded model", row && row.models.length === 1 && row.models[0] === B.id, row && JSON.stringify(row.models));

  const stale = await turn(c, sid, "Are you still there?");
  ok("chat still set to the unloaded model is refused, not sent", stale.status === "error" && /isn't loaded|currently has only/i.test(stale.text), String(stale.text).slice(0, 200));
  ok("…and no completion request was made for it", mock.completions.length === swapIndex);

  /* 3. user picks B in the same chat */
  await pick(c, sid, B.id);
  const t3 = await turn(c, sid, "Reply with the word OK.");
  ok("same chat, re-pointed to model B, completes", t3.status === "complete", `status=${t3.status} text=${String(t3.text).slice(0, 200)}`);
  await quiesce(mock);
  const afterSwap = mock.completions.slice(swapIndex);
  const bad = afterSwap.filter((r) => !r.loadedAtRequest.includes(r.model));
  ok("HAZARD CHECK: zero requests after the swap named an UNLOADED model (no JIT load / Bionic eviction)",
    bad.length === 0, `unloaded models requested: ${JSON.stringify(bad.map((r) => r.model))}`);
  ok("post-swap requests all went to model B", afterSwap.length > 0 && afterSwap.every((r) => r.model === B.id), JSON.stringify(afterSwap.map((r) => r.model)));

  /* 4. switch back to A while both are loaded: A's own Hermes session resumes with its history */
  mock.setLoaded([A, B]);
  await pick(c, sid, A.id);
  const beforeBack = mock.completions.length;
  const t4 = await turn(c, sid, "What word did I ask you to remember?");
  ok("switching back to A completes", t4.status === "complete", `status=${t4.status}`);
  const backReqs = mock.completions.slice(beforeBack).filter((r) => r.model === A.id);
  ok("switch-back asks for model A", backReqs.length > 0, JSON.stringify(mock.completions.slice(beforeBack).map((r) => r.model)));
  ok("…and resumes A's own session history (PINEAPPLE is in the request)",
    backReqs.some((r) => JSON.stringify(r.messages).includes("PINEAPPLE")));

  /* 5. a model loaded with a context too small for the agent */
  mock.setLoaded([TINY]);
  const opts5 = await c.rpc("model.options", { session_id: sid }, 30000);
  const row5 = opts5.providers.find((p) => p.slug === "frozen-local");
  ok("picker warns about the tiny context", !!row5 && /context/i.test(row5.warning || ""), row5 && row5.warning);
  const refusedTiny = await pick(c, sid, TINY.id).then(() => null, (e) => e);
  ok("selecting a model with too little context is refused with a reason", !!refusedTiny && /context/i.test(refusedTiny.message), refusedTiny ? refusedTiny.message : "accepted");

  /* 6. a loaded model LM Studio doesn't mark as tool-capable */
  mock.setLoaded([NOTOOLS]);
  const opts6 = await c.rpc("model.options", { session_id: sid }, 30000);
  const row6 = opts6.providers.find((p) => p.slug === "frozen-local");
  ok("picker warns the model isn't tool-capable", !!row6 && /tool/i.test(row6.warning || ""), row6 && row6.warning);

  if (mock.unknown.length) console.log(`  (mock saw unhandled endpoints: ${[...new Set(mock.unknown)].join(", ")})`);
  killGatewayTree();
  await mock.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("SWAP E2E ERROR:", e.message || e);
  killGatewayTree();
  process.exit(2);
});
