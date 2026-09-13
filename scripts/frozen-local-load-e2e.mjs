/* Frozen Local — LOAD-ON-DEMAND end-to-end test. Never touches the real Frozen PC.
 *
 *   node scripts/frozen-local-load-e2e.mjs
 *
 * Policy under test (Michael, 2026-09-13): when Frozen has NO chat model loaded,
 * a Frozen Local turn loads its chat's model — with the context it last ran with
 * and a 1-hour idle TTL — and never loads while ANY other model is loaded.
 *
 * Throwaway gateway (fresh GROK_GATEWAY_HOME) + mock LM Studio
 * (scripts/mock-lmstudio.mjs) + fake ssh (scripts/fake-ssh.mjs, via the
 * FROZEN_SSH_CMD seam) that emulates the `lms` CLI. Real installed Hermes agent.
 * Exit 0 = pass. */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startMockLmStudio } from "./mock-lmstudio.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const PORT = Number(process.env.GW_PORT || 8799);
const TOKEN = "frozen-load-e2e-token";
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-load-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-load-work-"));
const LOCAL_LIMIT_MS = 60_000; // FROZEN_ABSOLUTE_TIMEOUT_MS for this test only

const H = { id: "mock/model-hotel", ctx: 131072 };  // the chat's model; ran before at 131072
const G = { id: "mock/model-golf", ctx: 131072 };   // "Bionic's" model

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

/** Submit a prompt; resolve { done, statusLines } once that turn's message.complete arrives. */
async function turn(c, sid, text, timeout = 300000) {
  const from = c.events.length;
  const doneP = c.waitEvent((e) => e.session_id === sid && e.type === "message.complete", timeout);
  await c.rpc("prompt.submit", { session_id: sid, text });
  const done = (await doneP).payload;
  const statusLines = c.events.slice(from)
    .filter((e) => e.session_id === sid && e.type === "reasoning.delta" && /^(Loading|Waiting|Heads-up)/.test(e.payload?.text || ""))
    .map((e) => e.payload.text.trim());
  return { done, statusLines };
}
const pick = (c, sid, model) => c.rpc("config.set", { session_id: sid, key: "model", value: `${model} --provider frozen-local --session` }, 30000);
const frozenRow = async (c, sid) => (await c.rpc("model.options", sid ? { session_id: sid } : {}, 30000)).providers.find((p) => p.slug === "frozen-local");

(async () => {
  const mock = await startMockLmStudio({ loaded: [], downloaded: [H, G] });
  // H ran before at 131072 — the gateway must reload it at exactly that context.
  fs.writeFileSync(path.join(home, "frozen-models.json"), JSON.stringify({ [H.id]: { contextLength: 131072 } }, null, 2));
  console.log(`mock LM Studio :${mock.port}   test gateway :${PORT}`);

  gw = spawn(process.execPath, [path.join(repo, "server.mjs")], {
    cwd: repo, windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      GROK_GATEWAY_PORT: String(PORT), GROK_GATEWAY_TOKEN: TOKEN, GROK_GATEWAY_HOME: home,
      FROZEN_LOCAL_PORT: String(mock.port),
      FROZEN_SSH_TARGET: "mock@frozen",
      FROZEN_SSH_CMD: JSON.stringify([process.execPath, path.join(here, "fake-ssh.mjs")]),
      FAKE_SSH_MOCK_PORT: String(mock.port),
      FROZEN_ABSOLUTE_TIMEOUT_MS: String(LOCAL_LIMIT_MS),
    },
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* retry */ }
    await sleep(500);
  }
  const c = new Client();
  await c.open();

  /* 1. picker with nothing loaded offers the model this gateway ran before */
  const row0 = await frozenRow(c, null);
  ok("nothing loaded: picker still offers the remembered model", !!row0 && row0.models.length === 1 && row0.models[0] === H.id, row0 && JSON.stringify(row0.models));
  ok("…with a 'will load on your first message' note", !!row0 && /load/i.test(row0.warning || "") && /first message/i.test(row0.warning || ""), row0 && row0.warning);

  /* 2. selection rules with nothing loaded */
  const sid = (await c.rpc("session.create", { cwd: work })).session_id;
  const picked = await pick(c, sid, H.id).then(() => true, (e) => e);
  ok("nothing loaded: selecting a downloaded model is accepted", picked === true, picked && picked.message);
  const missing = await pick(c, sid, "mock/not-downloaded").then(() => null, (e) => e);
  ok("selecting a model that isn't downloaded is refused", !!missing && missing.code === 4041 && /isn't downloaded/i.test(missing.message), missing ? missing.message : "accepted");

  /* 3. first turn loads, then answers */
  const t1 = await turn(c, sid, "Reply with the word OK.");
  ok("first turn completes", t1.done.status === "complete", `status=${t1.done.status} text=${String(t1.done.text).slice(0, 200)}`);
  ok("user saw a 'Loading … on Frozen' status line", t1.statusLines.some((l) => /^Loading/.test(l) && l.includes(H.id)), JSON.stringify(t1.statusLines));
  ok("exactly one load was issued", mock.loads.length === 1, JSON.stringify(mock.loads));
  const L = mock.loads[0] || {};
  ok("load used the context the model last ran with (131072)", L.contextLength === 131072, `ctx=${L.contextLength}`);
  ok("load set a 1-hour idle TTL (matches LM Studio Bionic's idle unload)", L.ttl === 3600, `ttl=${L.ttl}`);
  ok("load kept the API identifier chats use", L.key === H.id && L.identifier === H.id && L.yes === true, JSON.stringify(L));
  const firstReq = mock.completions[0];
  ok("no request reached the model before the load finished", !!firstReq && firstReq.at >= L.at && firstReq.loadedAtRequest.includes(H.id), firstReq && JSON.stringify(firstReq.loadedAtRequest));
  ok("every request named a model that was loaded at that moment", mock.completions.every((r) => r.loadedAtRequest.includes(r.model)));

  /* 4. already loaded: no second load */
  const t2 = await turn(c, sid, "Reply with the word AGAIN.");
  ok("second turn completes without loading again", t2.done.status === "complete" && mock.loads.length === 1, `status=${t2.done.status} loads=${mock.loads.length}`);

  /* 5. another model loaded: never swap it out */
  mock.setLoaded([G]);
  const loadsBefore5 = mock.loads.length, reqsBefore5 = mock.completions.length;
  const t5 = await turn(c, sid, "Are you there?");
  ok("other model loaded: turn is refused", t5.done.status === "error" && /isn't loaded/i.test(t5.done.text) && t5.done.text.includes(G.id), String(t5.done.text).slice(0, 220));
  ok("…with no load and no model request", mock.loads.length === loadsBefore5 && mock.completions.length === reqsBefore5);
  const sid2 = (await c.rpc("session.create", { cwd: work })).session_id;
  const refusedPick = await pick(c, sid2, H.id).then(() => null, (e) => e);
  ok("other model loaded: selecting a different model is refused", !!refusedPick && refusedPick.code === 4041, refusedPick ? refusedPick.message : "accepted");
  const row5 = await frozenRow(c, null);
  ok("other model loaded: picker offers only that loaded model", !!row5 && row5.models.length === 1 && row5.models[0] === G.id, row5 && JSON.stringify(row5.models));

  /* 6. RACE: nothing loaded at first look, but Bionic loads G before we take the slot */
  mock.setLoaded([]);
  mock.flipAfterProbes(1, [G]); // the turn's first probe sees nothing; the re-check under the slot sees G
  const loadsBefore6 = mock.loads.length;
  const t6 = await turn(c, sid, "Race check.");
  ok("race: re-check under the slot sees Bionic's model and refuses", t6.done.status === "error" && t6.done.text.includes(G.id), String(t6.done.text).slice(0, 220));
  ok("race: NO load was issued on top of Bionic's model", mock.loads.length === loadsBefore6, `loads=${mock.loads.length}`);

  /* 7. load failure is a clean error, nothing sent */
  mock.setLoaded([]);
  mock.setFailLoad(true);
  const reqsBefore7 = mock.completions.length;
  const t7 = await turn(c, sid, "Fail check.");
  ok("load failure: turn ends with a clear error", t7.done.status === "error" && /Couldn't load/i.test(t7.done.text) && /not enough memory/i.test(t7.done.text), String(t7.done.text).slice(0, 220));
  ok("load failure: nothing was sent to the model", mock.completions.length === reqsBefore7);
  mock.setFailLoad(false);

  /* 8. local turns honor FROZEN_ABSOLUTE_TIMEOUT_MS (the 45-min Grok limit no longer applies) */
  mock.setLoaded([{ ...H, ctx: 131072 }]);
  mock.setCompletionDelay(LOCAL_LIMIT_MS * 3);
  const t8 = await turn(c, sid, "Slow check.", LOCAL_LIMIT_MS * 4);
  // Same rule as server.mjs formatDuration(): under a minute in seconds, otherwise whole minutes.
  const limitText = LOCAL_LIMIT_MS < 60_000 ? `${Math.round(LOCAL_LIMIT_MS / 1000)}s` : `${Math.round(LOCAL_LIMIT_MS / 60_000)} min`;
  ok("local turn is stopped by FROZEN_ABSOLUTE_TIMEOUT_MS, and the message names that limit",
    t8.done.status === "error" && /safety limit/i.test(t8.done.text) && t8.done.text.includes(`past the ${limitText} safety limit`),
    String(t8.done.text).slice(-220));
  mock.setCompletionDelay(0);

  if (mock.unknown.length) console.log(`  (mock saw unhandled endpoints: ${[...new Set(mock.unknown)].join(", ")})`);
  killGatewayTree();
  await mock.close();
  try { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch { /* files may still be held briefly */ }
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("LOAD E2E ERROR:", e.message || e);
  killGatewayTree();
  process.exit(2);
});
