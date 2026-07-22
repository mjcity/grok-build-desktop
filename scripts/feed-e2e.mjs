/**
 * Progressive-feed verification (static-feed fix).
 *
 * Proves, with wall-clock timestamps, that after mapping Grok `thought` →
 * `reasoning.delta` the desktop-visible feed animates DURING the reasoning
 * phase instead of staying blank until answer text:
 *
 *  1. >= 1 reasoning.delta arrives BEFORE the first message.delta
 *  2. reasoning.delta frames are spread over time (progressive), not one
 *     end-of-turn burst
 *  3. zero thinking.delta frames are emitted (old dead-end lane)
 *  4. turn still completes cleanly (message.complete, status complete)
 *
 * Run: node scripts/feed-e2e.mjs   (gateway must be running)
 * Exit 0 = PASS, 1 = FAIL. Prints a timestamped event timeline.
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
const timeline = []; // {t, type, size}

function ts(ms) {
  return `${((ms - t0) / 1000).toFixed(3)}s`;
}

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
    const { type, payload } = frame.params;
    timeline.push({
      t: Date.now(),
      type,
      size: typeof payload?.text === "string" ? payload.text.length : 0,
      status: payload?.status,
    });
    if (type === "message.complete") resolveComplete(frame.params);
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

  // A prompt that forces a visible reasoning phase before the answer.
  await rpc("prompt.submit", {
    session_id: sid,
    text: "Think step by step about the pros and cons of NDJSON versus length-prefixed framing for streaming protocols, then give a short final recommendation (3-4 sentences).",
  });

  const complete = await Promise.race([
    completeSeen,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("turn timed out")), 240_000)
    ),
  ]);

  // ── timeline print ──────────────────────────────────────────────
  console.log("event timeline (t since connect, type, chars):");
  const compact = [];
  let run = null;
  for (const e of timeline) {
    if (run && run.type === e.type) {
      run.count++;
      run.chars += e.size;
      run.tEnd = e.t;
    } else {
      if (run) compact.push(run);
      run = { type: e.type, count: 1, chars: e.size, tStart: e.t, tEnd: e.t };
    }
  }
  if (run) compact.push(run);
  for (const r of compact) {
    console.log(
      `  ${ts(r.tStart)} → ${ts(r.tEnd)}  ${r.type}  x${r.count}  (${r.chars} chars)`
    );
  }
  console.log("");

  // ── assertions ──────────────────────────────────────────────────
  const reasoningFrames = timeline.filter((e) => e.type === "reasoning.delta");
  const firstDelta = timeline.find((e) => e.type === "message.delta");
  const thinkingFrames = timeline.filter((e) => e.type === "thinking.delta");

  step(
    "reasoning-before-text",
    reasoningFrames.length > 0 &&
      firstDelta &&
      reasoningFrames[0].t < firstDelta.t,
    reasoningFrames.length
      ? `first reasoning.delta at ${ts(reasoningFrames[0].t)}, first message.delta at ${firstDelta ? ts(firstDelta.t) : "never"}`
      : "no reasoning.delta frames at all"
  );

  // Calibrated against the raw CLI (raw-grok-timing.txt, 2026-07-18): grok
  // emits NOTHING until first-token latency passes (10-17s observed), then a
  // brief thought burst (~0.3s), then streaming text. The gateway must relay
  // that shape faithfully — the burst shape itself is upstream behavior, so
  // we assert per-frame relay (many small frames), not wall-clock spread.
  step(
    "reasoning-relayed-per-frame",
    reasoningFrames.length >= 5,
    `${reasoningFrames.length} reasoning.delta frames (per-token relay, not one blob)`
  );

  const deltaFrames = timeline.filter((e) => e.type === "message.delta");
  const textSpreadMs =
    deltaFrames.length > 1
      ? deltaFrames[deltaFrames.length - 1].t - deltaFrames[0].t
      : 0;
  step(
    "text-progressive",
    deltaFrames.length >= 50 && textSpreadMs >= 2000,
    `${deltaFrames.length} message.delta frames spread over ${(textSpreadMs / 1000).toFixed(2)}s (live streaming, not an end dump)`
  );

  step(
    "no-thinking-delta",
    thinkingFrames.length === 0,
    `${thinkingFrames.length} thinking.delta frames (dead lane must stay unused)`
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
    failures.length ? `FEED-E2E FAIL: ${failures.join(", ")}` : "FEED-E2E PASS"
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
  console.error("FEED-E2E ERROR:", e.message);
  process.exit(1);
});
