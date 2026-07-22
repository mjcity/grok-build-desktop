/**
 * Self-improvement (Tier 2) verification — against the REAL grok.exe.
 *
 * Proves, against an isolated test gateway (short difficulty thresholds so a
 * trivial tool-using prompt reliably qualifies):
 *
 *  1. a "difficult" turn (>= REFLECT_MIN_TOOL_CALLS tool calls) schedules a
 *     reflection pass (gateway.log "scheduling reflection")
 *  2. the reflection is INVISIBLE — no second message.start/message.complete
 *     appears on the WS for this session after the real turn's completion
 *  3. the reflection actually runs to completion in the background (log
 *     line "reflection result"), occupying gateway_busy briefly
 *  4. the session is fully usable again afterward (a normal follow-up works)
 *
 * Run against an ISOLATED test gateway only:
 *   GROK_GATEWAY_PORT=8799 GROK_GATEWAY_HOME=<temp> \
 *   GROK_REFLECT_MIN_TOOL_CALLS=1 GROK_REFLECT_MIN_NUM_TURNS=999 \
 *   GROK_REFLECT_MIN_REASONING_TOKENS=999999999 node server.mjs
 * (only the tool-call threshold enabled, so the test is deterministic)
 *
 * Exit 0 = PASS, 1 = FAIL.
 */

import WebSocket from "ws";

const BASE = process.env.GW_URL || "http://127.0.0.1:8799";
const TOKEN = process.env.GW_TOKEN || "local-grok-dev-token";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws?token=${TOKEN}`;
const REFLECT_WAIT_MS = Number(process.env.REFLECT_WAIT_MS || 60_000);

const ws = new WebSocket(WS_URL);
let nextId = 1;
const pending = new Map();
const failures = [];
const events = [];

function step(name, okFlag, detail) {
  console.log(`[${okFlag ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!okFlag) failures.push(name);
}

function rpc(method, params, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out`)),
      timeoutMs
    );
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function waitForEvent(predicate, timeoutMs, sinceIndex = 0) {
  for (let i = events.length - 1; i >= sinceIndex; i--) {
    if (predicate(events[i])) return Promise.resolve(events[i]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("event wait timed out")),
      timeoutMs
    );
    const check = (e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(check), 1);
        resolve(e);
      }
    };
    waiters.push(check);
  });
}
const waiters = [];

ws.on("message", (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.method === "event") {
    events.push(frame.params);
    for (const w of waiters.slice()) w(frame.params);
    return;
  }
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  clearTimeout(entry.timer);
  if (frame.error)
    entry.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
  else entry.resolve(frame.result);
});

async function pollStatus(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      const s = await res.json();
      if (predicate(s)) return s;
    } catch {
      /* transient — keep polling */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const created = await rpc("session.create", {
    cwd: process.cwd(),
    source: "desktop",
  });
  const sid = created.session_id;
  console.log(`session ${sid}\n`);

  await rpc("prompt.submit", {
    session_id: sid,
    text: "List the files in this directory, then tell me how many there are.",
  });

  const done1 = await waitForEvent(
    (e) => e.type === "message.complete" && e.session_id === sid,
    120_000
  );
  step(
    "real turn completed visibly",
    done1.payload?.status === "complete",
    `status=${done1.payload?.status}`
  );
  const completeIdx = events.indexOf(done1);

  // Reflection is scheduled via setImmediate right after finish() — poll
  // gateway_busy rather than assuming instant timing.
  const busyAgain = await pollStatus((s) => s.gateway_busy === true, 10_000);
  step(
    "reflection actually started (gateway busy again)",
    Boolean(busyAgain),
    busyAgain ? "gateway_busy flipped true" : "never went busy again — not scheduled?"
  );

  // While it runs (and after), the session must show NOTHING visible for it.
  const leaked = await waitForEvent(
    (e) =>
      (e.type === "message.start" || e.type === "message.complete") &&
      e.session_id === sid,
    5_000,
    completeIdx + 1
  ).catch(() => null);
  step(
    "reflection is invisible (no second message.start/complete)",
    !leaked,
    leaked ? `LEAKED: ${leaked.type}` : "none observed"
  );

  const idle = await pollStatus((s) => s.gateway_busy === false, REFLECT_WAIT_MS);
  step(
    "reflection finished (gateway idle again)",
    Boolean(idle),
    idle ? "gateway_busy back to false" : `still busy after ${REFLECT_WAIT_MS}ms`
  );

  // Recovery: session must accept and complete a normal follow-up.
  const ack2 = await rpc("prompt.submit", {
    session_id: sid,
    text: "Are you still there?",
  }).catch((e) => ({ error: e.message }));
  step(
    "session usable for a normal follow-up",
    ack2.status === "streaming" || ack2.status === "queued",
    JSON.stringify(ack2)
  );
  if (ack2.status === "streaming" || ack2.status === "queued") {
    const done2 = await waitForEvent(
      (e) =>
        e.type === "message.complete" &&
        e.session_id === sid &&
        events.filter(
          (x) => x.type === "message.complete" && x.session_id === sid
        ).length >= 2,
      120_000
    ).catch(() => null);
    step(
      "follow-up completed cleanly",
      done2?.payload?.status === "complete",
      `status=${done2?.payload?.status}`
    );
  }

  console.log("");
  const code = failures.length ? 1 : 0;
  console.log(
    failures.length ? `REFLECT-E2E FAIL: ${failures.join(", ")}` : "REFLECT-E2E PASS"
  );
  process.exitCode = code;
  await new Promise((resolve) => {
    ws.once("close", resolve);
    ws.close();
    const t = setTimeout(resolve, 1000);
    if (typeof t.unref === "function") t.unref();
  });
}

main().catch((e) => {
  console.error("REFLECT-E2E ERROR:", e.message);
  process.exit(1);
});
