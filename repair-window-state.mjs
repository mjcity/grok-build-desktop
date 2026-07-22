/**
 * Repair window-state.json only when missing or corrupt.
 *
 * Position (x/y) is deliberately left to Hermes itself: the packaged build's
 * electron/window-state.ts drops saved coords unless >=48px of the window is
 * visible on a connected display's work area (display-aware, multi-monitor
 * correct — better than any external guess). We only guarantee the file is
 * valid JSON with sane width/height so that logic gets clean input.
 *
 * Usage: node repair-window-state.mjs <path-to-window-state.json>
 */

import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node repair-window-state.mjs <window-state.json>");
  process.exit(2);
}

const DEFAULT = { x: 60, y: 40, width: 1100, height: 680, isMaximized: false };

function valid(state) {
  if (!state || typeof state !== "object") return false;
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  if (!n(state.width) || !n(state.height)) return false;
  if (state.width < 400 || state.height < 300) return false;
  if (state.width > 10000 || state.height > 10000) return false;
  if (state.x !== undefined && (!n(state.x) || Math.abs(state.x) > 20000)) return false;
  if (state.y !== undefined && (!n(state.y) || Math.abs(state.y) > 20000)) return false;
  return true;
}

let current = null;
try {
  current = JSON.parse(fs.readFileSync(target, "utf8"));
} catch {
  /* missing or corrupt */
}

if (valid(current)) {
  console.log(`window-state ok: ${JSON.stringify(current)}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(DEFAULT, null, 2));
console.log(`window-state repaired -> ${JSON.stringify(DEFAULT)}`);
