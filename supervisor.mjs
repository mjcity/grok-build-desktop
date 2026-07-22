/**
 * Grok Gateway Supervisor — keeps server.mjs alive.
 *
 * - Single instance via supervisor.pid (PID liveness check, stale files reclaimed)
 * - Restarts the gateway on exit with exponential backoff (1s → 30s, resets after 60s stable)
 * - Health-polls GET /api/status every 10s; kills + restarts only when IDLE and
 *   unreachable for ~60s, or as a last-resort ~10min backstop while BUSY (a real
 *   turn's own in-process stall watchdog is the primary defense while busy —
 *   see server.mjs — so a busy-but-briefly-unreachable gateway is never nuked)
 * - Logs to ~/.grok-hermes-desktop/logs/{supervisor.log,gateway-out.log} with size rotation
 * - Ctrl+C / SIGTERM / console close stops the child and removes PID files
 *
 * Run: node supervisor.mjs   (from grok-gateway/; the launcher starts it minimized, never hidden)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GROK_GATEWAY_PORT || 8787);
const DATA = process.env.GROK_GATEWAY_HOME || path.join(os.homedir(), ".grok-hermes-desktop");
const LOGS = path.join(DATA, "logs");
const SUP_PID = path.join(DATA, "supervisor.pid");
const GW_PID = path.join(DATA, "gateway.pid");
const SERVER = path.join(__dirname, "server.mjs");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATIONS = 3;
// Threshold calibration, round 2 (2026-07-20 — a real user task was killed
// mid-turn by round 1's "fix"). This machine has genuine, unexplained
// loopback flakiness: plain curl.exe / Node fetch succeed instantly on the
// same port at the same moment health-check-style HTTP clients see
// ETIMEDOUT (confirmed directly — see project notes). It comes in bursts
// that can produce 3 consecutive failures within 30s even though the
// gateway is fully alive and correctly mid-turn. Killing on that basis
// silently destroys real, in-progress work with zero graceful message —
// strictly worse than the failure mode it's meant to prevent, because the
// gateway's OWN stall watchdog (server.mjs, per-turn, activity-based)
// already handles a genuinely hung grok.exe gracefully from the inside.
//
// New rule: the supervisor only force-kills on confirmed HTTP failure when
// the gateway was last known IDLE (safe — nothing to lose). If it was last
// known BUSY (a real turn in flight), it trusts the in-process stall
// watchdog and just keeps polling/logging, with a much longer last-resort
// backstop in case that watchdog itself somehow never fires.
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_FAILS_TO_KILL_IDLE = 6; // ~60s of continuous failure while idle
const HEALTH_FAILS_TO_KILL_BUSY = 60; // ~10min backstop while a turn was in flight
const KILL_GRACE_MS = 2_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_RESET_MS = 60_000;

fs.mkdirSync(LOGS, { recursive: true });

function rotate(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* rotation is best-effort */
  }
}

const SUP_LOG = path.join(LOGS, "supervisor.log");
const GW_LOG = path.join(LOGS, "gateway-out.log");

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  rotate(SUP_LOG);
  try {
    fs.appendFileSync(SUP_LOG, line);
  } catch {
    /* ignore */
  }
  process.stdout.write(line);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill node and its whole process tree (critical on Windows — plain kill leaves grok.exe). */
function forceKillTree(pid, reason) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  log(`forceKillTree pid=${pid} reason=${reason}`);
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (e) {
      log(`taskkill failed: ${e.message}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

// ── single instance ───────────────────────────────────────────────────────
try {
  const existing = Number(fs.readFileSync(SUP_PID, "utf8").trim());
  if (existing !== process.pid && pidAlive(existing)) {
    log(`supervisor already running (pid ${existing}); exiting`);
    process.exit(0);
  }
} catch {
  /* no pid file */
}
fs.writeFileSync(SUP_PID, String(process.pid));

// ── child lifecycle ───────────────────────────────────────────────────────
let child = null;
let shuttingDown = false;
let backoff = BACKOFF_START_MS;
let startedAt = 0;
let healthFails = 0;
let lastKnownBusy = false; // from the last SUCCESSFUL health check's gateway_busy field

function startGateway() {
  if (shuttingDown) return;
  rotate(GW_LOG);
  const out = fs.openSync(GW_LOG, "a");
  child = spawn(process.execPath, [SERVER], {
    cwd: __dirname,
    env: { ...process.env, GROK_GATEWAY_PORT: String(PORT) },
    stdio: ["ignore", out, out],
    windowsHide: true, // child console only; the supervisor itself stays visible
  });
  fs.closeSync(out);
  startedAt = Date.now();
  healthFails = 0;
  lastKnownBusy = false; // unknown state on a fresh process — assume idle (safer threshold)
  fs.writeFileSync(GW_PID, String(child.pid));
  log(`gateway started pid=${child.pid} port=${PORT}`);

  child.on("exit", (code, signal) => {
    log(`gateway exited code=${code} signal=${signal}`);
    child = null;
    try {
      fs.unlinkSync(GW_PID);
    } catch {
      /* ignore */
    }
    if (shuttingDown) return;
    const uptime = Date.now() - startedAt;
    if (uptime > STABLE_RESET_MS) backoff = BACKOFF_START_MS;
    log(`restarting gateway in ${backoff}ms`);
    setTimeout(startGateway, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  });
}

function checkHealth() {
  if (shuttingDown || !child) return;
  const req = http.get(
    // agent:false — a fresh socket per probe. The default keep-alive agent
    // can wedge on a half-open socket left by a killed gateway; every later
    // probe then queues behind it and times out, producing an endless
    // false-positive kill/restart loop while other clients connect fine.
    {
      host: "127.0.0.1",
      port: PORT,
      path: "/api/status",
      timeout: HEALTH_TIMEOUT_MS,
      agent: false,
    },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          healthFails = 0;
          try {
            lastKnownBusy = Boolean(JSON.parse(body)?.gateway_busy);
          } catch {
            /* keep previous lastKnownBusy on a parse hiccup */
          }
        } else {
          onHealthFail(`status ${res.statusCode}`);
        }
      });
    }
  );
  req.on("timeout", () => {
    req.destroy(new Error("timeout"));
  });
  req.on("error", (err) => onHealthFail(err.message));
}

function onHealthFail(reason) {
  healthFails += 1;
  const threshold = lastKnownBusy
    ? HEALTH_FAILS_TO_KILL_BUSY
    : HEALTH_FAILS_TO_KILL_IDLE;
  log(
    `health check failed (${healthFails}/${threshold}, lastKnownBusy=${lastKnownBusy}): ${reason}`
  );
  if (healthFails >= threshold && child) {
    const pid = child.pid;
    log(
      `gateway unhealthy after ${healthFails} failures (busy=${lastKnownBusy}); tree-killing pid=${pid} for restart`
    );
    // Soft kill first (lets exit handler fire), then hard tree-kill if still alive.
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (pidAlive(pid)) forceKillTree(pid, "health-fail-grace");
    }, KILL_GRACE_MS);
  }
}

setInterval(checkHealth, HEALTH_INTERVAL_MS);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`supervisor shutting down (${signal})`);
  if (child) {
    const pid = child.pid;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    forceKillTree(pid, `shutdown-${signal}`);
  }
  for (const f of [SUP_PID, GW_PID]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("uncaughtException", (err) => {
  log(`supervisor uncaught: ${err.stack || err.message}`);
});

log(`supervisor started pid=${process.pid} (node ${process.version})`);
startGateway();
