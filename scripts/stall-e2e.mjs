/**
 * Stall-watchdog verification — against the REAL grok.exe, not a stand-in.
 *
 * Reproduces the 2026-07-20 incident precisely: submits a real prompt, then
 * suspends the spawned grok.exe process's threads (ntdll!NtSuspendProcess,
 * via a PowerShell one-liner — this is the same mechanism debugging tools
 * use; it freezes every thread, guaranteeing zero further CPU/output exactly
 * like the observed hang) before it can respond. Proves the gateway:
 *
 *  1. detects the silence and completes the turn anyway (not stuck forever)
 *  2. reports status "error" with a clear explanation (not a bare exit code
 *     or a silently empty "complete")
 *  3. unlocks the session afterward for a normal follow-up prompt
 *
 * Run against an ISOLATED test gateway only (short GROK_STALL_TIMEOUT_MS,
 * separate GROK_GATEWAY_HOME/PORT) — never against the real one, since this
 * deliberately creates a stuck grok.exe process.
 *
 * CALIBRATION WARNING (learned the hard way, 2026-07-20): GROK_STALL_TIMEOUT_MS
 * for this test MUST be longer than startTurnKeepalive's own re-announcement
 * cycle (~16-20s: an 8s tick, only fires past 12s of quiet — so worst case
 * ~20s between real refreshes) or this test PASSES even when the watchdog is
 * completely broken in production. That's exactly what happened: an earlier
 * run used 8000ms (shorter than the keepalive cycle) and passed cleanly,
 * while the real 3-minute production default was silently defeated the whole
 * time by a bug where the keepalive's own synthetic emit() fed the same
 * activity clock the watchdog checked (fixed — see the comment on emit() in
 * server.mjs). Use >= 25000 here to actually exercise the regime that
 * matters: STALL_TIMEOUT_MS longer than the keepalive cycle, same shape as
 * production's 180000ms default.
 *
 * Exit 0 = PASS, 1 = FAIL.
 */

import { execFileSync } from "node:child_process";
import WebSocket from "ws";

const BASE = process.env.GW_URL || "http://127.0.0.1:8799";
const TOKEN = process.env.GW_TOKEN || "local-grok-dev-token";
const WS_URL = `${BASE.replace(/^http/, "ws")}/api/ws?token=${TOKEN}`;
const STALL_TIMEOUT_MS = Number(process.env.GROK_STALL_TIMEOUT_MS || 8000);
const WAIT_MS = STALL_TIMEOUT_MS + 25_000; // generous headroom over the watchdog's own poll interval

const ws = new WebSocket(WS_URL);
let nextId = 1;
const pending = new Map();
const failures = [];
const events = [];
const waiters = [];

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

function waitForEvent(predicate, timeoutMs) {
  for (const e of events) if (predicate(e)) return Promise.resolve(e);
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

function findNewestGrokPid(sinceMs) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='grok.exe'" | Where-Object { $_.CreationDate -gt (Get-Date '${new Date(sinceMs).toISOString()}') } | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId`;
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", ps],
      { encoding: "utf8" }
    ).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

function suspendProcess(pid) {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ProcCtl {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
$h = [ProcCtl]::OpenProcess(0x0800, $false, ${pid})
[ProcCtl]::NtSuspendProcess($h) | Out-Null
[ProcCtl]::CloseHandle($h) | Out-Null
`.trim();
  execFileSync("powershell", ["-NoProfile", "-Command", ps]);
}

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

  const submitAt = Date.now();
  await rpc("prompt.submit", {
    session_id: sid,
    text: "Write a three-paragraph explanation of TCP slow start.",
  });

  // Grab the real grok.exe the gateway just spawned and freeze it before it
  // can finish naturally — poll briefly since spawn is near-instant but not
  // synchronous from our side.
  let pid = null;
  for (let i = 0; i < 20 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 150));
    pid = findNewestGrokPid(submitAt - 2000);
  }
  step("found the spawned grok.exe", Boolean(pid), `pid=${pid}`);
  if (!pid) throw new Error("could not locate spawned grok.exe — aborting");

  suspendProcess(pid);
  const suspendedAt = Date.now();
  console.log(`suspended pid=${pid} at t=0s — now waiting for the watchdog...\n`);

  const done = await waitForEvent(
    (e) => e.type === "message.complete" && e.session_id === sid,
    WAIT_MS
  ).catch(() => null);
  const elapsedS = ((Date.now() - suspendedAt) / 1000).toFixed(1);

  step(
    "auto-recovers (not stuck forever)",
    Boolean(done),
    done
      ? `message.complete ${elapsedS}s after suspend`
      : `no completion within ${WAIT_MS}ms of suspending`
  );

  if (done) {
    step(
      "status is error, not silent complete",
      done.payload?.status === "error",
      `status=${done.payload?.status}`
    );
    step(
      "explains the stall (not a bare exit code)",
      /stopped responding|no activity|safety limit/i.test(done.payload?.text || ""),
      `text=${JSON.stringify((done.payload?.text || "").slice(-160))}`
    );
  }

  // Leftover safety net in case the gateway's own tree-kill somehow missed it
  // (suspended processes still respond to taskkill fine, so this is belt-
  // and-braces only, not expected to be needed).
  try {
    execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore", // expected to already be gone — the gateway's own tree-kill got there first
    });
  } catch {
    /* already gone, which is the expected/correct outcome */
  }

  const ack2 = await rpc("prompt.submit", {
    session_id: sid,
    text: "are we unstuck",
  }).catch((e) => ({ error: e.message }));
  step(
    "session unlocked for a new prompt",
    ack2.status === "streaming" || ack2.status === "queued",
    JSON.stringify(ack2)
  );
  // Let the recovery prompt actually finish so it doesn't leak into the next
  // run as yet another stuck grok.exe.
  if (ack2.status === "streaming") {
    await waitForEvent(
      (e) =>
        e.type === "message.complete" &&
        e.session_id === sid &&
        events.filter(
          (x) => x.type === "message.complete" && x.session_id === sid
        ).length >= 2,
      60_000
    ).catch(() => null);
  }

  console.log("");
  const code = failures.length ? 1 : 0;
  console.log(
    failures.length ? `STALL-E2E FAIL: ${failures.join(", ")}` : "STALL-E2E PASS"
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
  console.error("STALL-E2E ERROR:", e.message);
  process.exit(1);
});
