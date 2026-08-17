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

const WINDOW = 6.5 * 24 * 60 * 60 * 1000;
let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.error("  FAIL  " + name); }
};

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
    "exhaustedAt", "fs", "path", "log", "ACCOUNT_RESET_WINDOW_MS",
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

/* 2. marked exhausted, credentials OLDER than the marker → still blocked */
{
  const { fn, exhaustedAt } = makeUsable(NOW - 60 * 60 * 1000); // auth 1h before marker
  exhaustedAt.set(HOME, NOW - 30 * 60 * 1000);                  // marked 30m ago
  ok("marker + stale credentials → still blocked", fn(a, NOW) === false);
}

/* 3. THE FIX: marked exhausted, then a fresh `grok login` → usable again */
{
  const { fn, exhaustedAt } = makeUsable(NOW - 60 * 1000);       // auth 1m ago
  exhaustedAt.set(HOME, NOW - 30 * 60 * 1000);                   // marked 30m ago
  const usable = fn(a, NOW);
  ok("re-login (auth newer than marker) → usable", usable === true);
  ok("re-login clears the marker from the map", !exhaustedAt.has(HOME));
}

/* 4. marker older than the weekly window → usable regardless */
{
  const { fn, exhaustedAt } = makeUsable(NOW - 10 * 24 * 3600 * 1000);
  exhaustedAt.set(HOME, NOW - (WINDOW + 60_000));
  ok("marker past reset window → usable", fn(a, NOW) === true);
}

/* 5. missing auth.json must not crash or wrongly unblock */
{
  const { fn, exhaustedAt } = makeUsable(null);
  exhaustedAt.set(HOME, NOW - 30 * 60 * 1000);
  ok("missing auth.json → no crash, stays blocked", fn(a, NOW) === false);
}

/* 6. MUTATION CHECK — the gate must actually be capable of failing.
   Feed it the OLD implementation; test 3 must fail, proving the test has
   teeth and isn't passing for an unrelated reason. */
{
  const oldImpl =
    "function accountUsable(a, now) {\n" +
    "  const ex = exhaustedAt.get(a.home);\n" +
    "  return !ex || now - ex > ACCOUNT_RESET_WINDOW_MS;\n" +
    "}";
  const { fn, exhaustedAt } = makeUsable(NOW - 60 * 1000, oldImpl);
  exhaustedAt.set(HOME, NOW - 30 * 60 * 1000);
  ok("mutation: old impl DOES strand a re-login (test has teeth)", fn(a, NOW) === false);
}

console.log("\n  RESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
