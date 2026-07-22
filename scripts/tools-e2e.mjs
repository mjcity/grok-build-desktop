/**
 * Tool-activity feed verification.
 *
 * Proves the gateway relays Grok's on-disk events.jsonl as live Hermes tool
 * chips during a tool-using turn:
 *  1. tool.start events arrive with real tool names
 *  2. every tool.start has a matching tool.complete (same tool_id) → checkmark
 *  3. tool events arrive DURING the turn (before message.complete), live
 *  4. turn completes cleanly
 *
 * Run: node scripts/tools-e2e.mjs   (gateway must be running)
 * Exit 0 = PASS, 1 = FAIL. Prints a timestamped timeline.
 */

import WebSocket from "ws";

const BASE = process.env.GW_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.GW_TOKEN || "local-grok-dev-token";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws?token=${TOKEN}`;

const ws = new WebSocket(WS_URL);
let nextId = 1;
const pending = new Map();
const failures = [];
const t0 = Date.now();
const events = [];

const ts = (ms) => `${((ms - t0) / 1000).toFixed(2)}s`;

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

let resolveComplete;
const completeSeen = new Promise((r) => (resolveComplete = r));

ws.on("message", (raw) => {
  const frame = JSON.parse(String(raw));
  if (frame.method === "event") {
    events.push({ t: Date.now(), ...frame.params });
    if (frame.params.type === "message.complete")
      resolveComplete(frame.params);
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

  await rpc("prompt.submit", {
    session_id: sid,
    text: "List the files in the notes folder, read the first 10 lines of any two of them, then summarize in 2 sentences what kinds of notes live there.",
  });

  const complete = await Promise.race([
    completeSeen,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("turn timed out")), 300_000)
    ),
  ]);
  const completeAt = events.find((e) => e.type === "message.complete").t;

  const starts = events.filter((e) => e.type === "tool.start");
  const completes = events.filter((e) => e.type === "tool.complete");

  console.log("tool timeline:");
  for (const e of events.filter((x) => x.type.startsWith("tool."))) {
    console.log(
      `  ${ts(e.t)}  ${e.type}  ${e.payload?.name}  id=${e.payload?.tool_id}${e.payload?.duration_ms != null ? ` (${e.payload.duration_ms}ms)` : ""}`
    );
  }
  console.log("");

  step(
    "tool-starts-observed",
    starts.length >= 2 && starts.every((e) => typeof e.payload?.name === "string" && e.payload.name),
    `${starts.length} tool.start events, names: ${[...new Set(starts.map((e) => e.payload?.name))].join(", ")}`
  );

  const unmatched = starts.filter(
    (s) => !completes.some((c) => c.payload?.tool_id === s.payload?.tool_id)
  );
  step(
    "every-chip-checked-off",
    starts.length > 0 && unmatched.length === 0,
    `${completes.length} tool.complete for ${starts.length} starts (unmatched: ${unmatched.length})`
  );

  const lastToolEvent = [...starts, ...completes].sort((a, b) => b.t - a.t)[0];
  step(
    "tools-live-during-turn",
    Boolean(lastToolEvent) && lastToolEvent.t < completeAt,
    lastToolEvent
      ? `last tool event at ${ts(lastToolEvent.t)}, message.complete at ${ts(completeAt)}`
      : "no tool events"
  );

  step(
    "turn-complete",
    complete.payload?.status === "complete" &&
      (complete.payload?.text || "").length > 0,
    `status=${complete.payload?.status} text=${(complete.payload?.text || "").length} chars`
  );

  console.log("");
  const code = failures.length ? 1 : 0;
  console.log(
    failures.length
      ? `TOOLS-E2E FAIL: ${failures.join(", ")}`
      : "TOOLS-E2E PASS"
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
  console.error("TOOLS-E2E ERROR:", e.message);
  process.exit(1);
});
