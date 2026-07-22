/**
 * Chat E2E against grok-gateway over the real Hermes WS protocol.
 *
 * Proves (Â§7 checklist):
 *  6. prompt â†’ streamed reply from the real Grok CLI (expected token seen)
 *  7. second prompt recalls turn-1 fact via --resume (same gateway session)
 *  plus: session survives in the HTTP session list with correct shapes.
 *
 * Run: node scripts/chat-e2e.mjs   (gateway must be running)
 * Exit 0 = PASS, 1 = FAIL.
 */

import WebSocket from "ws";

const BASE = process.env.GW_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.GW_TOKEN || "local-grok-dev-token";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws?token=${TOKEN}`;
const MAGIC = `E2E_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const ws = new WebSocket(WS_URL);
let nextId = 1;
const pending = new Map();
const failures = [];

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

const eventWaiters = [];
// Frames can coalesce into one TCP segment and get processed back-to-back in
// a single macrotask â€” by the time an awaiting caller registers its waiter,
// the frame it wants may already be in `events`. Scan history first (from
// sinceIndex), resolving with the LAST match, before arming a live waiter.
function waitForEvent(predicate, timeoutMs, sinceIndex = 0) {
  for (let i = events.length - 1; i >= sinceIndex; i--) {
    if (predicate(events[i])) return Promise.resolve(events[i]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("event wait timed out")),
      timeoutMs
    );
    eventWaiters.push({ predicate, resolve, timer });
  });
}

const events = [];
ws.on("message", (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.method === "event") {
    events.push(frame.params);
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      const w = eventWaiters[i];
      if (w.predicate(frame.params)) {
        clearTimeout(w.timer);
        eventWaiters.splice(i, 1);
        w.resolve(frame.params);
      }
    }
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

function collectDeltas(sessionId) {
  return events
    .filter((e) => e.type === "message.delta" && e.session_id === sessionId)
    .map((e) => e.payload?.text || "")
    .join("");
}

async function main() {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const ready = await waitForEvent((e) => e.type === "gateway.ready", 5000);
  step(
    "gateway.ready",
    typeof ready.payload?.skin === "object",
    JSON.stringify(ready.payload)
  );

  const created = await rpc("session.create", {
    cwd: "D:\\Program\\grok",
    source: "desktop",
  });
  const sid = created.session_id;
  step(
    "session.create",
    Boolean(sid) && created.info?.desktop_contract >= 4,
    `session=${sid} contract=${created.info?.desktop_contract}`
  );

  // Turn 1 â€” expect the magic token streamed back
  const ack1 = await rpc("prompt.submit", {
    session_id: sid,
    text: `Reply with exactly this token and nothing else: ${MAGIC}`,
  });
  step("submit-1 ack", ack1.status === "streaming", JSON.stringify(ack1));

  const done1 = await waitForEvent(
    (e) => e.type === "message.complete" && e.session_id === sid,
    180_000
  );
  const streamed = collectDeltas(sid);
  step(
    "turn-1 stream",
    streamed.includes(MAGIC) && done1.payload?.text?.includes(MAGIC),
    `deltas contain token=${streamed.includes(MAGIC)} status=${done1.payload?.status}`
  );
  step(
    "turn-1 usage",
    typeof done1.payload?.usage?.total === "number",
    `usage.total=${done1.payload?.usage?.total}`
  );

  // session.info(running:false) is emitted right after message.complete.
  // Scan only from the message.complete frame onward â€” the session.create
  // flow also emits a running:false session.info which must not satisfy this.
  const completeIdx = events.findIndex(
    (e) => e.type === "message.complete" && e.session_id === sid
  );
  const infoAfter = await waitForEvent(
    (e) =>
      e.type === "session.info" &&
      e.session_id === sid &&
      e.payload?.running === false,
    10_000,
    completeIdx + 1
  );
  step(
    "session.info running:false",
    infoAfter.payload.desktop_contract >= 4,
    `running=${infoAfter.payload.running} contract=${infoAfter.payload.desktop_contract}`
  );

  // Turn 2 â€” multi-turn recall through --resume
  const ack2 = await rpc("prompt.submit", {
    session_id: sid,
    text: "What exact token did I ask you to reply with in my previous message? Reply with just that token.",
  });
  step("submit-2 ack", ack2.status === "streaming", JSON.stringify(ack2));

  // Turn 2's reply may be byte-identical to turn 1's (it IS just the token),
  // so wait for the SECOND message.complete by count, not by content.
  const done2 = await waitForEvent(
    (e) =>
      e.type === "message.complete" &&
      e.session_id === sid &&
      events.filter(
        (x) => x.type === "message.complete" && x.session_id === sid
      ).length >= 2,
    180_000
  );
  step(
    "turn-2 recalls turn-1 (--resume)",
    Boolean(done2.payload?.text?.includes(MAGIC)),
    `reply=${JSON.stringify((done2.payload?.text || "").slice(0, 80))}`
  );

  // HTTP: session listed with required shape
  const res = await fetch(
    `${BASE}/api/profiles/sessions?limit=50&offset=0&min_messages=1&archived=exclude&order=recent&profile=all`,
    { headers: { "X-Hermes-Session-Token": TOKEN } }
  );
  const body = await res.json();
  const row = (body.sessions || []).find((s) => s.id === sid);
  step(
    "http session list",
    Boolean(row) && typeof row.last_active === "number" && row.profile === "default",
    `listed=${Boolean(row)} message_count=${row?.message_count}`
  );

  const msgsRes = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
    headers: { "X-Hermes-Session-Token": TOKEN },
  });
  const msgs = await msgsRes.json();
  step(
    "http messages",
    Array.isArray(msgs.messages) && msgs.messages.length === 4,
    `messages=${msgs.messages?.length} (expect 4: 2 user + 2 assistant)`
  );

  console.log("");
  const code = failures.length ? 1 : 0;
  console.log(
    failures.length ? `CHAT-E2E FAIL: ${failures.join(", ")}` : "CHAT-E2E PASS"
  );
  // Set exitCode and let node exit naturally â€” process.exit() races libuv
  // handle teardown on Windows (async.c assertion, exit code 9).
  process.exitCode = code;
  await new Promise((resolve) => {
    ws.once("close", resolve);
    ws.close();
    const t = setTimeout(resolve, 1000);
    if (typeof t.unref === "function") t.unref();
  });
}

main().catch((e) => {
  console.error("CHAT-E2E ERROR:", e.message);
  process.exit(1);
});
