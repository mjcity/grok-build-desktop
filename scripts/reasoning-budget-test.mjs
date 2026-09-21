#!/usr/bin/env node
/**
 * Reasoning budget - unit test against the REAL functions in server.mjs.
 *
 * Extracts the helper block's source text rather than importing server.mjs
 * (which would start a gateway), so this can never drift from what ships.
 * Exit 0 = all checks pass. Includes a mutation check: the same assertions
 * must FAIL against the old pass-everything behavior, or they prove nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "server.mjs"), "utf8");

const start = src.indexOf("const REASONING_LIVE_CAP");
const end = src.indexOf("function displayMessages(s) {");
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: reasoning budget block not found in server.mjs");
  process.exit(1);
}
// server.mjs is CRLF on Windows checkouts. Normalize, or every "\n"-anchored
// pattern below silently matches nothing - which is how the first version of
// this file's mutation check "passed" against an unmutated mutant.
const block = src.slice(start, end).replace(/\r\n/g, "\n");

function load(code) {
  // eslint-disable-next-line no-new-func
  return new Function(
    "process",
    `${code}\nreturn { trimReasoning, createReasoningSink, REASONING_LIVE_CAP, REASONING_KEEP_HEAD, REASONING_KEEP_TAIL, REASONING_HIDDEN_NOTE };`
  )({ env: {} });
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

function run(api, label) {
  const { trimReasoning, createReasoningSink, REASONING_LIVE_CAP, REASONING_KEEP_HEAD, REASONING_KEEP_TAIL } = api;
  const results = [];
  const t = (name, ok, detail) => results.push({ name: `${label}${name}`, ok, detail });

  // --- trimReasoning (read-time, for already-stored blobs) ---
  t("null/empty -> null", trimReasoning(null) === null && trimReasoning("") === null);
  const small = "x".repeat(1000);
  t("small passes through untouched", trimReasoning(small) === small);
  const huge = "H".repeat(5000) + "M".repeat(170 * 1024) + "T".repeat(13000);
  const trimmed = trimReasoning(huge);
  t("176KB blob is cut to ~head+tail", trimmed.length < REASONING_KEEP_HEAD + REASONING_KEEP_TAIL + 200, `(${trimmed.length} chars)`);
  t("keeps the true head", trimmed.startsWith("H".repeat(REASONING_KEEP_HEAD)));
  t("keeps the true tail", trimmed.endsWith("T".repeat(Math.min(13000, REASONING_KEEP_TAIL))));
  t("says how much was dropped", /KB of reasoning trimmed/.test(trimmed));

  // --- sink: small stream is lossless ---
  const s1 = createReasoningSink();
  const parts = ["alpha ", "beta ", "gamma"];
  let live1 = "";
  for (const p of parts) { s1.account(p); live1 += s1.live(p) || ""; }
  t("small stream stored verbatim", s1.text() === parts.join(""));
  t("small stream forwarded verbatim", live1 === parts.join(""));
  t("total counts every char", s1.total === parts.join("").length);

  // --- sink: a 176KB thought stream in 64-char chunks ---
  const s2 = createReasoningSink();
  let live2 = "", frames = 0, nullsAfterCap = 0, n = 0;
  const chunk = "abcdefgh".repeat(8);
  while (n < 176 * 1024) {
    s2.account(chunk);
    const out = s2.live(chunk);
    if (out) { live2 += out; frames++; } else nullsAfterCap++;
    n += chunk.length;
  }
  t("live forwarding stops at the cap", live2.length <= REASONING_LIVE_CAP + 200, `(${live2.length} chars forwarded of ${n})`);
  t("exactly one 'hidden' note is sent", (live2.match(/still thinking/g) || []).length === 1);
  t("chunks after the cap forward nothing", nullsAfterCap > 1000, `(${nullsAfterCap} suppressed)`);
  t("stored text is bounded", s2.text().length < REASONING_KEEP_HEAD + REASONING_KEEP_TAIL + 200, `(${s2.text().length} chars)`);
  t("total still reflects the real size", s2.total === n);
  return results;
}

// 1) the real code must pass everything
for (const r of run(load(block), "")) check(r.name, r.ok, r.detail);

// 2) mutation: old behavior (forward everything, store everything) must FAIL the bounded checks
const mutant = block
  .replace(/live\(t\) \{[\s\S]*?\n    \},\n    get total/, "live(t) { return t || null; },\n    get total")
  .replace(/function trimReasoning\(text\) \{[\s\S]*?\n\}\n/, "function trimReasoning(text) { return text || null; }\n");
// A mutation check is only evidence if the mutation actually happened.
check("mutation applied: live() replaced", !/forwarded >= REASONING_LIVE_CAP/.test(mutant.slice(mutant.indexOf("live(t)"), mutant.indexOf("get total"))));
check("mutation applied: trimReasoning() replaced", /function trimReasoning\(text\) \{ return text \|\| null; \}/.test(mutant));
const mutantResults = run(load(mutant), "[mutant] ");
const caught = mutantResults.filter((r) => !r.ok).map((r) => r.name);
check("mutation check: pass-everything behavior is caught", caught.length >= 3, `(${caught.length} checks failed as they should)`);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
