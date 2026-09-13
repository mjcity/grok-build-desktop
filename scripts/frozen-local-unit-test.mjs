/* Frozen Local — unit tests for the pure logic in local-provider.mjs.
 *   node scripts/frozen-local-unit-test.mjs   → exit 0 = pass
 * No network, no processes. Live behavior is covered by frozen-local-e2e.mjs. */
import {
  parseModelSwitch,
  loadedModelsFrom,
  mapAcpUpdate,
  settleOpenTools,
  choosePermission,
  upsertModelBlock,
  modelFromChoice,
  assessModel,
  HERMES_CONTEXT_FLOOR,
  LOCAL_SLUG,
} from "../local-provider.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.error("  FAIL  " + name); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ── parseModelSwitch: the exact value the stock desktop sends ── */
ok("desktop value with --session", eq(parseModelSwitch("huihui-qwen3.8-27b-abliterated --provider frozen-local --session"),
  { model: "huihui-qwen3.8-27b-abliterated", provider: "frozen-local", session: true }));
ok("desktop value without --session", eq(parseModelSwitch("grok-4.6 --provider grok-cli"), { model: "grok-4.6", provider: "grok-cli", session: false }));
ok("--provider=slug form", parseModelSwitch("x --provider=frozen-local").provider === LOCAL_SLUG);
ok("unknown flags are not folded into the model id", parseModelSwitch("m1 --confirm --provider grok-cli").model === "m1");
ok("empty / flag-only value -> null", parseModelSwitch("") === null && parseModelSwitch("--provider grok-cli") === null);

/* ── loadedModelsFrom: the no-JIT-load guard's source of truth ── */
// Mirrors Frozen's REAL /api/v0/models on 2026-09-13: 14 downloaded, 1 loaded.
const fixture = { data: [
  { id: "huihui-qwen3.8-27b-abliterated", type: "vlm", state: "loaded", loaded_context_length: 143360, max_context_length: 262144 },
  { id: "google/gemma-4-31b", type: "vlm", state: "not-loaded", max_context_length: 131072 },
  { id: "gemma-4-31b-it-abliterated-i1", type: "llm", state: "not-loaded" },
  { id: "zai-org/glm-4.7-flash", type: "llm", state: "not-loaded" },
  { id: "unsloth/qwen3.8-27b", type: "llm", state: "not-loaded" },
  { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "loaded" },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `other-${i}`, type: "llm", state: "not-loaded" })),
] };
const loaded = loadedModelsFrom(fixture);
ok("only the loaded chat model is offered (14 listed -> 1)", loaded.length === 1 && loaded[0].id === "huihui-qwen3.8-27b-abliterated");
ok("loaded context is carried, not the advertised max", loaded[0].contextLength === 143360 && loaded[0].maxContextLength === 262144);
ok("a loaded EMBEDDING model is never offered for chat", !loaded.some((m) => m.type === "embeddings"));
ok("malformed payload -> empty, no throw", eq(loadedModelsFrom(null), []) && eq(loadedModelsFrom({}), []));
// MUTATION: if the state filter were removed, not-loaded models would leak in.
const mutant = (p) => ((p && p.data) || []).filter((m) => m.type === "llm" || m.type === "vlm");
ok("MUTATION: dropping the state filter would offer JIT-loadable models (guard has teeth)", mutant(fixture).length > 1);

/* ── mapAcpUpdate: ACP -> the desktop events the Grok path emits ── */
const st = { tools: new Map(), seq: 0 };
const SID = "abcdef12-0000";
const m1 = mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }, st, SID);
ok("message chunk -> message.delta + text", m1.length === 1 && m1[0].type === "message.delta" && m1[0].payload.text === "Hello" && m1[0].text === "Hello");
const r1 = mapAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } }, st, SID);
ok("thought chunk -> reasoning.delta", r1.length === 1 && r1[0].type === "reasoning.delta" && r1[0].reasoning === "thinking");
const t1 = mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "terminal: ls", kind: "execute", status: "pending" }, st, SID);
ok("tool_call -> tool.start with a stable chip id + title", t1.length === 1 && t1[0].type === "tool.start" && t1[0].payload.name === "terminal: ls" && /^abcdef12-L1$/.test(t1[0].payload.tool_id));
const t2 = mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "in_progress" }, st, SID);
ok("in_progress update emits nothing", t2.length === 0);
const t3 = mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" }, st, SID);
ok("completed -> tool.complete on the SAME chip with duration", t3.length === 1 && t3[0].type === "tool.complete" && t3[0].payload.tool_id === t1[0].payload.tool_id && typeof t3[0].payload.duration_ms === "number" && !t3[0].payload.error);
ok("a duplicate completion never double-emits", mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" }, st, SID).length === 0);
mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "tc2", title: "write_file", status: "pending" }, st, SID);
const f1 = mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc2", status: "failed" }, st, SID);
ok("failed tool -> tool.complete carrying an error", f1.length === 1 && f1[0].payload.error === "failed");
const u1 = mapAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "never-seen", title: "search: *", status: "completed" }, st, SID);
ok("update for an unseen call opens then closes a chip", u1.length === 2 && u1[0].type === "tool.start" && u1[1].type === "tool.complete");
mapAcpUpdate({ sessionUpdate: "usage_update", used: 7334, size: 143360 }, st, SID);
ok("usage_update records context use, emits nothing", st.contextUsed === 7334 && st.contextSize === 143360);
ok("unknown / housekeeping kinds map to nothing", ["session_info_update", "available_commands_update", "plan", "current_mode_update"]
  .every((k) => mapAcpUpdate({ sessionUpdate: k }, st, SID).length === 0));
ok("empty text chunks emit nothing (no blank deltas)", mapAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, st, SID).length === 0);

/* ── settleOpenTools: a cancelled/failed turn never leaves a spinning chip ── */
const st2 = { tools: new Map(), seq: 0 };
mapAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "a", title: "long job", status: "in_progress" }, st2, SID);
const s1 = settleOpenTools(st2, "cancelled");
ok("open chip is closed exactly once with the reason", s1.length === 1 && s1[0].payload.error === "cancelled" && settleOpenTools(st2, "cancelled").length === 0);

/* ── choosePermission: approval policy ── */
const opts = [
  { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow-always", kind: "allow_always", name: "Always" },
  { optionId: "deny", kind: "reject_once", name: "Deny" },
];
ok("policy allow -> allow_once (parity with grok --always-approve)", eq(choosePermission(opts, "allow"), { outcome: { outcome: "selected", optionId: "allow-once" } }));
ok("policy deny -> reject_once", eq(choosePermission(opts, "deny"), { outcome: { outcome: "selected", optionId: "deny" } }));
ok("allow never escalates to allow_always when allow_once exists", choosePermission(opts, "allow").outcome.optionId !== "allow-always");
ok("no options -> cancelled, never a guessed approval", eq(choosePermission([], "allow"), { outcome: { outcome: "cancelled" } }));

/* ── upsertModelBlock: keeps the profile in sync without clobbering it ── */
const yaml = "model:\n  provider: lmstudio\n  default: old-model\n  base_url: http://127.0.0.1:12345/v1\n  context_length: 143360\n  lmstudio_load_mode: jit\nplugins:\n  enabled:\n    - grok-deny-mirror\n  disabled: []\n";
const y2 = upsertModelBlock(yaml, { default: "new-model", lmstudio_load_mode: "jit" });
ok("updates model.default in place", /\n  default: new-model\n/.test(y2) && !/old-model/.test(y2));
ok("preserves the plugins block (deny-mirror stays enabled)", /plugins:\n  enabled:\n    - grok-deny-mirror/.test(y2));
ok("adds a missing key inside the model block", /\n  streaming: false/.test(upsertModelBlock(yaml, { streaming: "false" })));
ok("creates the model block when absent", /^model:\n  provider: lmstudio/.test(upsertModelBlock("plugins:\n  enabled: []\n", { provider: "lmstudio" })));
ok("idempotent (same values -> same text)", upsertModelBlock(yaml, { default: "old-model" }) === yaml);

/* ── modelFromChoice: which model a Hermes session is BOUND to ── */
ok("strips Hermes' lmstudio: prefix", modelFromChoice("lmstudio:huihui-qwen3.8-27b-abliterated") === "huihui-qwen3.8-27b-abliterated");
ok("keeps colons inside the model id", modelFromChoice("lmstudio:qwen3:8b@q4_k_m") === "qwen3:8b@q4_k_m");
ok("empty / missing -> empty string (treated as NOT a match)", modelFromChoice(undefined) === "" && modelFromChoice("") === "");
ok("a different provider prefix is not silently stripped", modelFromChoice("openrouter:x") === "openrouter:x");

/* ── loadedModelsFrom carries tool capability ── */
const caps = loadedModelsFrom({ data: [
  { id: "t", type: "llm", state: "loaded", loaded_context_length: 131072, capabilities: ["tool_use"] },
  { id: "n", type: "llm", state: "loaded", loaded_context_length: 131072, capabilities: [] },
  { id: "u", type: "llm", state: "loaded", loaded_context_length: 131072 },
] });
ok("tool_use capability -> toolUse true / false / null(unknown)", caps[0].toolUse === true && caps[1].toolUse === false && caps[2].toolUse === null);

/* ── assessModel: refuse what can't run, warn what may struggle ── */
const big = assessModel({ id: "big", contextLength: 143360, toolUse: true });
ok("the real Frozen model (143K, tool_use) -> no refusal, no warning", big.refuse === null && big.warn.length === 0);
const tiny = assessModel({ id: "tiny", contextLength: 4096, toolUse: true });
ok("LM Studio's small default context (4K) is REFUSED with a fix", !!tiny.refuse && /context/i.test(tiny.refuse) && /LM Studio/.test(tiny.refuse));
const mid = assessModel({ id: "mid", contextLength: 32768, toolUse: true });
ok("32K runs but warns (below Hermes' 64K tool-use floor)", mid.refuse === null && mid.warn.length === 1 && mid.warn[0].includes(String(HERMES_CONTEXT_FLOOR / 1000)));
const notool = assessModel({ id: "nt", contextLength: 143360, toolUse: false });
ok("not tool-capable -> warning, not refusal", notool.refuse === null && /tool-capable/.test(notool.warn.join(" ")));
ok("unknown capability (null) is not flagged", assessModel({ id: "u", contextLength: 143360, toolUse: null }).warn.length === 0);
ok("unknown context (null) is not refused", assessModel({ id: "u", contextLength: null, toolUse: true }).refuse === null);

console.log(`\n  RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
