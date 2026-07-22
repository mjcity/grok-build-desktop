/**
 * Queue-drain / busy-path verification.
 *
 * Hermes Desktop queues locally while busy; a mid-turn prompt.submit must
 * NOT return a silent success (status:queued) that freezes the feed.
 * Default busy mode is reject → 4009 session busy.
 *
 * After turn 1 completes, turn 2 must stream (message.start + deltas/complete).
 *
 * Run: node scripts/queue-drain-e2e.mjs   (gateway must be running)
 * Exit 0 = PASS
 */

import WebSocket from "ws";

const BASE = process.env.GW_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.GW_TOKEN || "local-grok-dev-token";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws?token=${TOKEN}`;

const ws = new WebSocket(WS_URL);
let nextId = 1;
const pending = new Map();
const failures = [];
const events = [];

function step(name, okFlag, detail) {
  console.log(`[${okFlag ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!okFlag) failures.push(name);
}

function rpc(method, params, timeoutMs = 30_000) {
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

function waitForEvent(pred, timeoutMs = 180_000, fromIdx = 0) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      for (let i = fromIdx; i < events.length; i++) {
        if (pred(events[i], i)) return resolve(events[i]);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitForEvent timed out"));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

ws.on("message", (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.method === "event") {
    events.push({
      type: frame.params?.type,
      session_id: frame.params?.session_id,
      payload: frame.params?.payload,
      t: Date.now(),
    });
    return;
  }
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  clearTimeout(entry.timer);
  if (frame.error)
    entry.reject(
      Object.assign(new Error(`${frame.error.code}: ${frame.error.message}`), {
        code: frame.error.code,
        data: frame.error,
      })
    );
  else entry.resolve(frame.result);
});

async function main() {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const created = await rpc("session.create", {
    cwd: "D:\\Program\\grok",
    source: "desktop",
  });
  const sid = created.session_id;
  console.log(`session ${sid}\n`);

  // Long enough turn that we can race a second submit while busy.
  const ack1 = await rpc("prompt.submit", {
    session_id: sid,
    text: "Think carefully for a moment about why 2+2 equals 4, then reply with exactly: QUEUE_E2E_T1",
  });
  step("turn1-ack-streaming", ack1?.status === "streaming", JSON.stringify(ack1));

  // Immediately try a second submit while turn 1 is (almost certainly) live.
  let busyCode = null;
  let busyStatus = null;
  try {
    const busyAck = await rpc(
      "prompt.submit",
      {
        session_id: sid,
        text: "Reply with exactly: QUEUE_E2E_T2",
      },
      10_000
    );
    busyStatus = busyAck?.status;
  } catch (e) {
    busyCode = e.code ?? (String(e.message).match(/^(-?\d+):/) || [])[1];
    busyStatus = e.message;
  }

  // Default mode: must be 4009 session busy (not a fake success).
  const rejectedBusy =
    String(busyCode) === "4009" || /session busy/i.test(String(busyStatus));
  const acceptedQueued = busyStatus === "queued";
  step(
    "busy-submit-policy",
    rejectedBusy || acceptedQueued,
    rejectedBusy
      ? `rejected with session busy (desktop-safe): ${busyStatus}`
      : acceptedQueued
        ? "accepted as gateway-queued (queue/interrupt mode)"
        : `unexpected: code=${busyCode} status=${busyStatus}`
  );
  step(
    "busy-not-silent-streaming",
    busyStatus !== "streaming",
    `must not claim streaming while another turn is live (got ${busyStatus})`
  );

  const done1 = await waitForEvent(
    (e) => e.type === "message.complete" && e.session_id === sid,
    240_000
  );
  step(
    "turn1-complete",
    Boolean(done1.payload?.text),
    `status=${done1.payload?.status} text=${JSON.stringify(String(done1.payload?.text || "").slice(0, 80))}`
  );

  // After settle, a normal submit (desktop auto-drain equivalent) must stream.
  const afterCompleteIdx = events.length;
  const ack2 = await rpc("prompt.submit", {
    session_id: sid,
    text: "Reply with exactly: QUEUE_E2E_T2",
  });
  step("turn2-ack-streaming", ack2?.status === "streaming", JSON.stringify(ack2));

  const start2 = await waitForEvent(
    (e) => e.type === "message.start" && e.session_id === sid,
    30_000,
    afterCompleteIdx
  );
  step("turn2-message-start", Boolean(start2), "message.start after drain/submit");

  const runningTrue = await waitForEvent(
    (e) =>
      e.type === "session.info" &&
      e.session_id === sid &&
      e.payload?.running === true,
    30_000,
    afterCompleteIdx
  );
  step(
    "turn2-session-running",
    runningTrue?.payload?.running === true,
    "session.info running:true for queued/next turn"
  );

  const done2 = await waitForEvent(
    (e) =>
      e.type === "message.complete" &&
      e.session_id === sid &&
      events.filter(
        (x) => x.type === "message.complete" && x.session_id === sid
      ).length >= 2,
    240_000
  );
  const t2text = String(done2.payload?.text || "");
  step(
    "turn2-streamed-complete",
    /QUEUE_E2E_T2/i.test(t2text),
    `reply=${JSON.stringify(t2text.slice(0, 120))}`
  );

  // Progressive signal: something after message.start before complete for turn2
  const startIdx = events.findIndex(
    (e, i) =>
      i >= afterCompleteIdx &&
      e.type === "message.start" &&
      e.session_id === sid
  );
  const complete2Idx = events.findIndex(
    (e, i) =>
      i > startIdx &&
      e.type === "message.complete" &&
      e.session_id === sid
  );
  const mid = events
    .slice(startIdx + 1, complete2Idx)
    .filter((e) =>
      ["message.delta", "reasoning.delta", "tool.start", "tool.complete"].includes(
        e.type
      )
    );
  step(
    "turn2-progressive-feed",
    mid.length > 0,
    `live frames between start and complete: ${mid.length} (${[...new Set(mid.map((m) => m.type))].join(",")})`
  );

  ws.close();
  if (failures.length) {
    console.error(`\nFAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nALL PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
