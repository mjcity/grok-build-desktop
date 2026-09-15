/* Frozen Local — REPLACE-WITH-CONFIRM end-to-end test. Never touches the real Frozen PC.
 *
 *   node scripts/frozen-local-replace-e2e.mjs
 *
 * Policy under test (Michael, 2026-09-15): parity with original Hermes — the
 * model menu lists every model downloaded on Frozen; picking one that isn't
 * loaded while another is loaded asks for a Confirm (the desktop's own dialog,
 * via `confirm_required` on config.set); on confirm, the next turn unloads the
 * old model and loads the new one. One confirm = one swap; if the loaded set
 * changes before the turn (Bionic), nothing is evicted.
 *
 * Throwaway gateway + mock LM Studio + fake ssh. Real installed Hermes agent.
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
const PORT = Number(process.env.GW_PORT || 8800);
const TOKEN = "frozen-replace-e2e-token";
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-replace-home-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-replace-work-"));

const G = { id: "mock/model-golf", ctx: 131072 };   // "Bionic's" model, loaded at start
const H = { id: "mock/model-hotel", ctx: 131072 };  // what the user picks; context comes from original Hermes' config
const K = { id: "mock/model-kilo", ctx: 131072 };   // something Bionic loads mid-flight
const H_HERMES_CTX = 98304;

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

async function turn(c, sid, text, timeout = 300000) {
  const from = c.events.length;
  const doneP = c.waitEvent((e) => e.session_id === sid && e.type === "message.complete", timeout);
  await c.rpc("prompt.submit", { session_id: sid, text });
  const done = (await doneP).payload;
  const statusLines = c.events.slice(from)
    .filter((e) => e.session_id === sid && e.type === "reasoning.delta" && /^(Loading|Unloading|Waiting|Heads-up)/.test(e.payload?.text || ""))
    .map((e) => e.payload.text.trim());
  return { done, statusLines };
}
/** Exactly what the desktop sends: first plain, then (after its Confirm dialog) with confirm_expensive_model. */
const pick = (c, sid, model, confirmed = false) =>
  c.rpc("config.set", { session_id: sid, key: "model", value: `${model} --provider frozen-local --session`, ...(confirmed ? { confirm_expensive_model: true } : {}) }, 30000);
const frozenRow = async (c, sid) => (await c.rpc("model.options", sid ? { session_id: sid } : {}, 30000)).providers.find((p) => p.slug === "frozen-local");

(async () => {
  const mock = await startMockLmStudio({ loaded: [G], downloaded: [G, H, K] });
  // original Hermes' config (the real file's shape) — H's context should come from here
  const hermesCfg = path.join(home, "og-hermes-config.yaml");
  fs.writeFileSync(hermesCfg, [
    "model:", "  default: x", "  provider: lmstudio",
    "providers:", "  lmstudio:", "    name: OG Frozen (LM Studio)", "    models:",
    `      ${H.id}:`, `        context_length: ${H_HERMES_CTX}`, `      ${G.id}: {}`, "    api_mode: chat_completions", "",
  ].join("\n"));
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
      FROZEN_HERMES_CONFIG: hermesCfg,
    },
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1500) })).ok) break; } catch { /* retry */ }
    await sleep(500);
  }
  const c = new Client();
  await c.open();

  /* 1. the menu: every downloaded model, loaded first, with a note */
  const row0 = await frozenRow(c, null);
  ok("menu lists every downloaded model (like original Hermes)", !!row0 && [G.id, H.id, K.id].every((id) => row0.models.includes(id)), row0 && JSON.stringify(row0.models));
  ok("loaded model is listed first", !!row0 && row0.models[0] === G.id);
  ok("menu note says what's loaded and that a swap asks to confirm", !!row0 && /Loaded now: .*golf/.test(row0.warning || "") && /confirm/i.test(row0.warning || ""), row0 && row0.warning);

  /* 2. picking an unloaded model while G is loaded → confirm_required, nothing touched */
  const sid = (await c.rpc("session.create", { cwd: work })).session_id;
  const first = await pick(c, sid, H.id);
  ok("first pick answers confirm_required with a message naming both models",
    first && first.confirm_required === true && first.confirm_message.includes(G.id) && first.confirm_message.includes(H.id), JSON.stringify(first));
  ok("…and nothing happened on Frozen", mock.unloads.length === 0 && mock.loads.length === 0);
  const infoBefore = await c.rpc("session.resume", { session_id: sid });
  ok("…and the chat is still on Grok until confirmed", infoBefore.info.provider === "grok-cli", infoBefore.info.provider);

  /* 3. confirmed pick → accepted, still nothing touched until a message */
  const second = await pick(c, sid, H.id, true);
  ok("confirmed pick is accepted", second && !second.confirm_required && !second.deferred, JSON.stringify(second));
  const infoAfter = await c.rpc("session.resume", { session_id: sid });
  ok("chat now set to Frozen Local / H", infoAfter.info.provider === "frozen-local" && infoAfter.info.model === H.id);
  ok("still nothing unloaded/loaded before the first message", mock.unloads.length === 0 && mock.loads.length === 0);

  /* 4. the turn performs the swap: unload G, load H, then answer on H */
  const t1 = await turn(c, sid, "Reply with the word OK.");
  ok("swap turn completes", t1.done.status === "complete", `status=${t1.done.status} text=${String(t1.done.text).slice(0, 200)}`);
  ok("user saw the 'Unloading … then loading' status", t1.statusLines.some((l) => /^Unloading/.test(l) && l.includes(G.id) && l.includes(H.id)), JSON.stringify(t1.statusLines));
  ok("exactly one unload (G) and one load (H)", mock.unloads.length === 1 && mock.unloads[0].id === G.id && mock.loads.length === 1 && mock.loads[0].key === H.id, JSON.stringify({ unloads: mock.unloads, loads: mock.loads.map((l) => l.key) }));
  ok("unload happened BEFORE the load", mock.unloads[0] && mock.loads[0] && mock.unloads[0].at <= mock.loads[0].at);
  ok("H was loaded with original Hermes' context for it", mock.loads[0] && mock.loads[0].contextLength === H_HERMES_CTX, `ctx=${mock.loads[0] && mock.loads[0].contextLength}`);
  ok("H got the 1-hour idle unload", mock.loads[0] && mock.loads[0].ttl === 3600);
  ok("never unloads with --all (embedding model stays)", mock.unloads.every((u) => !u.all));
  ok("every request named a model loaded at that moment", mock.completions.length > 0 && mock.completions.every((r) => r.loadedAtRequest.includes(r.model)), JSON.stringify(mock.completions.map((r) => [r.model, r.loadedAtRequest])));
  ok("Frozen now holds only H", JSON.stringify(mock.loadedIds()) === JSON.stringify([H.id]), JSON.stringify(mock.loadedIds()));

  /* 5. second turn: no swap needed, nothing touched */
  const t2 = await turn(c, sid, "Reply with the word AGAIN.");
  ok("next turn runs on H without touching Frozen", t2.done.status === "complete" && mock.unloads.length === 1 && mock.loads.length === 1);

  /* 6. Bionic reloads G — one confirm was one swap, so this is REFUSED, not re-evicted */
  mock.setLoaded([G]);
  const t3 = await turn(c, sid, "Still there?");
  ok("Bionic's model back → turn refused with 'pick again and confirm'", t3.done.status === "error" && /again and confirm/i.test(t3.done.text) && t3.done.text.includes(G.id), String(t3.done.text).slice(0, 220));
  ok("…and nothing was unloaded or loaded", mock.unloads.length === 1 && mock.loads.length === 1);

  /* 7. re-pick H: confirm again → swap again */
  const again = await pick(c, sid, H.id);
  ok("re-pick asks to confirm again", again && again.confirm_required === true);
  await pick(c, sid, H.id, true);
  const t4 = await turn(c, sid, "Reply with the word BACK.");
  ok("second confirmed swap works", t4.done.status === "complete" && mock.unloads.length === 2 && mock.loads.length === 2 && JSON.stringify(mock.loadedIds()) === JSON.stringify([H.id]));

  /* 8. RACE: confirm against G, but Bionic loads K before the message is sent */
  mock.setLoaded([G]);
  await pick(c, sid, H.id);          // confirm_required
  await pick(c, sid, H.id, true);    // token: replacing [G]
  mock.setLoaded([K]);               // Bionic swaps in K before the turn
  const before8 = { u: mock.unloads.length, l: mock.loads.length };
  const t5 = await turn(c, sid, "Race.");
  ok("RACE: loaded set changed since the confirm → refused, K is NOT evicted",
    t5.done.status === "error" && t5.done.text.includes(K.id) && mock.unloads.length === before8.u && mock.loads.length === before8.l, String(t5.done.text).slice(0, 220));

  /* 9. picking the loaded model needs no confirm */
  const direct = await pick(c, sid, K.id);
  ok("picking the model that IS loaded needs no confirm", direct && !direct.confirm_required, JSON.stringify(direct));

  if (mock.unknown.length) console.log(`  (mock saw unhandled endpoints: ${[...new Set(mock.unknown)].join(", ")})`);
  killGatewayTree();
  await mock.close();
  try { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch { /* may still be held briefly */ }
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("REPLACE E2E ERROR:", e.message || e);
  killGatewayTree();
  process.exit(2);
});
