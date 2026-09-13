/* accountUsable() re-login test — extracts the REAL function source from
 * server.mjs and exercises it against stubbed fs/log, so it validates the
 * shipped code rather than a copy of it.
 *
 * Regression guarded (incident 2026-08-17): both account homes were marked
 * exhausted in-memory; the user then ran `grok login` into ~/.grok with a
 * fresh 0%-used account, but the marker is keyed by FOLDER, so the gateway
 * refused to touch it for 6.5 days. A re-login must clear the marker.
 *
 *   node scripts/account-relogin-test.mjs   → exit 0 = pass
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "server.mjs"), "utf8");

/* Pull the real function text out of the shipped source. */
const m = src.match(/function accountUsable\(a, now\) \{[\s\S]*?\n\}/);
if (!m) {
  console.error("FAIL: could not locate accountUsable() in server.mjs");
  process.exit(2);
}

/* The retry window is read FROM THE SHIPPED SOURCE, never hardcoded here.
   Re-aimed 2026-09-13: commit 2f951a4 (2026-08-19) renamed the constant
   ACCOUNT_RESET_WINDOW_MS -> ACCOUNT_RETRY_AFTER_MS and cut the default from
   6.5 days to 20 minutes. This test kept injecting the old name, so it had been
   crashing with a ReferenceError ever since — and with a 20-minute window its
   "marked 30 minutes ago" fixtures would have passed for the WRONG reason (the
   window, not the re-login clause). Now the constant name comes from the
   function body and every marker sits INSIDE the real window. */
const constName = (m[0].match(/now - ex > ([A-Z_][A-Z0-9_]*)/) || [])[1];
if (!constName) {
  console.error("FAIL: accountUsable() no longer compares `now - ex > <CONSTANT>` — re-aim this test to the new logic");
  process.exit(2);
}
const defMatch = src.match(new RegExp(`const ${constName} = Number\\(([\\s\\S]*?)\\n\\);`));
const defaultExpr = defMatch ? (defMatch[1].split("||").pop() || "").trim() : "";
if (!/^[\d\s*+.()]+$/.test(defaultExpr)) {
  console.error(`FAIL: could not read the numeric default of ${constName} from server.mjs (got ${JSON.stringify(defaultExpr)})`);
  process.exit(2);
}
const WINDOW = Function(`return (${defaultExpr});`)();
// A marker this recent is INSIDE the window, so only the re-login clause can unblock it.
const RECENT = Math.floor(WINDOW / 4);

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.error("  FAIL  " + name); }
};
console.log(`  (retry window ${constName} = ${WINDOW / 60000} min, read from server.mjs)`);

/* Build a runner with stubbed deps; `exhaustedAt`/`fs` are injected. */
function makeUsable(authMtimeMs, funcSrc = m[0]) {
  const exhaustedAt = new Map();
  const fsStub = {
    statSync: () => {
      if (authMtimeMs === null) throw new Error("ENOENT");
      return { mtimeMs: authMtimeMs };
    }
  };
  const fn = new Function(
    "exhaustedAt", "fs", "path", "log", constName,
    funcSrc + "; return accountUsable;"
  )(exhaustedAt, fsStub, path, () => {}, WINDOW);
  return { fn, exhaustedAt };
}

const NOW = 1_760_000_000_000;
const HOME = "C:\\Users\\anyae\\.grok";
const a = { home: HOME };

/* 1. no marker at all → usable */
{
  const { fn } = makeUsable(NOW - 1000);
  ok("no marker → usable", fn(a, NOW) === true);
}

/* 2. marked exhausted INSIDE the window, credentials OLDER than the marker → still blocked */
{
  const { fn, exhaustedAt } = makeUsable(NOW - RECENT - 60_000); // auth written before the marker
  exhaustedAt.set(HOME, NOW - RECENT);                           // marked recently (inside window)
  ok("marker + stale credentials → still blocked", fn(a, NOW) === false);
}

/* 3. THE FIX: marked exhausted INSIDE the window, then a fresh `grok login` → usable again.
   Inside the window, nothing but the re-login clause can make this true. */
{
  const { fn, exhaustedAt } = makeUsable(NOW - 1000);            // auth rewritten just now
  exhaustedAt.set(HOME, NOW - RECENT);                           // marked recently (inside window)
  const usable = fn(a, NOW);
  ok("re-login (auth newer than marker) → usable", usable === true);
  ok("re-login clears the marker from the map", !exhaustedAt.has(HOME));
}

/* 4. marker older than the retry window → usable regardless */
{
  const { fn, exhaustedAt } = makeUsable(NOW - WINDOW - 3_600_000);
  exhaustedAt.set(HOME, NOW - (WINDOW + 60_000));
  ok("marker past retry window → usable", fn(a, NOW) === true);
}

/* 5. missing auth.json must not crash or wrongly unblock */
{
  const { fn, exhaustedAt } = makeUsable(null);
  exhaustedAt.set(HOME, NOW - RECENT);
  ok("missing auth.json → no crash, stays blocked", fn(a, NOW) === false);
}

/* 6. MUTATION CHECK — the gate must actually be capable of failing.
   Feed it the OLD implementation (no re-login clause); test 3's scenario must
   stay blocked, proving the test has teeth and isn't passing for an unrelated
   reason such as the window expiring. */
{
  const oldImpl =
    "function accountUsable(a, now) {\n" +
    "  const ex = exhaustedAt.get(a.home);\n" +
    `  return !ex || now - ex > ${constName};\n` +
    "}";
  const { fn, exhaustedAt } = makeUsable(NOW - 1000, oldImpl);
  exhaustedAt.set(HOME, NOW - RECENT);
  ok("mutation: old impl DOES strand a re-login (test has teeth)", fn(a, NOW) === false);
}

console.log("\n  RESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
