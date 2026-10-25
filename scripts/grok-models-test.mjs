#!/usr/bin/env node
// parseGrokModels / effectiveGrokModel - extracted from the REAL server.mjs text.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"), "utf8").replace(/\r\n/g, "\n");
const a = src.indexOf("function parseGrokModels"), b = src.indexOf("/** Re-read the account's model list");
const c = src.indexOf("/** The model to actually pass to grok"), d = src.indexOf("// ── Multi-account weekly-balance fallback");
if ([a, b, c, d].some((i) => i < 0)) { console.error("FAIL: blocks not found"); process.exit(1); }
const load = (list, def, MODEL) => new Function(`const grokModelState={list:${JSON.stringify(list)},def:${JSON.stringify(def)}}; let MODEL=${JSON.stringify(MODEL)};
${src.slice(a, b)}\n${src.slice(c, d)}\nreturn {parseGrokModels, effectiveGrokModel};`)();
let fail = 0; const ck = (n, ok, x = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); if (!ok) fail++; };
const real = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n";
let t = load([], null, "grok-4.7").parseGrokModels(real);
ck("parses the real `grok models` output", t.def === "grok-4.7" && t.list.join() === "grok-4.7", JSON.stringify(t));
t = load([], null, "x").parseGrokModels("Default model: grok-5\n\nAvailable models:\n  grok-5 (default)\n  * grok-4.7\n  grok-code-fast\n");
ck("multiple models, star or not", t.list.join() === "grok-5,grok-4.7,grok-code-fast", t.list.join());
ck("garbage -> empty, no throw", load([], null, "x").parseGrokModels("Error: not signed in").list.length === 0);
const e = load(["grok-4.7"], "grok-4.7", "grok-4.7").effectiveGrokModel;
ck("retired grok-4.6 maps to the default", e("grok-4.6") === "grok-4.7");
ck("a current model passes through", e("grok-4.7") === "grok-4.7");
ck("no model -> gateway model", e() === "grok-4.7");
ck("unknown list (CLI unreadable) never rewrites", load([], null, "grok-4.7").effectiveGrokModel("grok-4.6") === "grok-4.6");
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS"); process.exit(fail ? 1 : 0);
