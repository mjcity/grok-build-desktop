/* A tiny LM Studio stand-in for tests that must NOT touch the real, shared
 * Frozen machine. It answers the endpoints Hermes and the gateway use, lets a
 * test change which models are "loaded" (simulating Bionic swapping models),
 * and RECORDS the model id on every completion request — the exact signal
 * that, on real LM Studio, would JIT-load a model and evict Bionic's.
 *
 *   const mock = await startMockLmStudio({ loaded: [{ id: "a", ctx: 143360 }] });
 *   mock.setLoaded([{ id: "b", ctx: 143360 }]);
 *   mock.completions  // [{ at, model, loadedAtRequest, messages }]
 */
import http from "node:http";

export function startMockLmStudio({ loaded = [], downloaded = [] } = {}) {
  const state = {
    loaded: [...loaded],
    downloaded: [...downloaded],
    failLoad: false,
    completionDelayMs: 0,
    flip: null, // { remaining, loaded } — swap the loaded set after N more /api/v0/models probes
  };
  const completions = [];
  const unknown = [];
  const loads = []; // every `lms load` the gateway ran: { at, key, contextLength, ttl, identifier, ok }
  const unloads = []; // every `lms unload`: { at, id, all, loadedBefore }
  let probes = 0;

  /** Emulate the subset of the `lms` CLI the gateway uses. */
  const tokenize = (s) => [...String(s).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  function runLms(command) {
    const t = tokenize(command);
    if (t[0] !== "lms") return { code: 127, stdout: "", stderr: `mock: not an lms command: ${command}` };
    if (t[1] === "ps" && t.includes("--json")) {
      const rows = state.loaded.map((m) => ({
        type: "llm", modelKey: m.id, identifier: m.identifier || m.id, contextLength: m.ctx || 32768,
        status: "idle", queued: 0, parallel: 1, ttlMs: m.ttl ? m.ttl * 1000 : null,
      }));
      return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
    }
    if (t[1] === "server" && t[2] === "start") return { code: 0, stdout: "Success! Server is now running on port 1234", stderr: "" };
    if (t[1] === "unload") {
      const all = t.includes("-a") || t.includes("--all");
      const id = all ? null : t[2];
      unloads.push({ at: Date.now(), id, all, loadedBefore: state.loaded.map((m) => m.id) });
      if (all) { state.loaded = []; return { code: 0, stdout: "Unloaded all models.", stderr: "" }; }
      if (!state.loaded.some((m) => m.id === id)) return { code: 1, stdout: "", stderr: `Error: No loaded model with identifier "${id}"` };
      state.loaded = state.loaded.filter((m) => m.id !== id);
      return { code: 0, stdout: `Model "${id}" unloaded.`, stderr: "" };
    }
    if (t[1] === "load") {
      const key = t[2];
      const opt = (name) => { const i = t.indexOf(name); return i >= 0 ? t[i + 1] : undefined; };
      const rec = {
        at: Date.now(), key,
        contextLength: Number(opt("--context-length")),
        ttl: Number(opt("--ttl")),
        identifier: opt("--identifier"),
        yes: t.includes("-y"),
        ok: false,
      };
      loads.push(rec);
      const def = state.downloaded.find((d) => d.id === key);
      if (state.failLoad) return { code: 1, stdout: "", stderr: "Error: mock load failure (not enough memory)" };
      if (!def) return { code: 1, stdout: "", stderr: `Error: No model found that matches "${key}"` };
      state.loaded = [...state.loaded, { ...def, id: rec.identifier || key, ctx: rec.contextLength || def.ctx, ttl: rec.ttl || null }];
      rec.ok = true;
      return { code: 0, stdout: `Model loaded successfully in 1.00s.\nTo use the model in the API/SDK, use the identifier "${rec.identifier || key}".`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `mock: unsupported lms command: ${command}` };
  }

  const entry = (m, isLoaded) => ({
    id: m.id,
    object: "model",
    type: m.type || "llm",
    publisher: "mock",
    arch: "mock",
    compatibility_type: "gguf",
    quantization: "Q4_K",
    state: isLoaded ? "loaded" : "not-loaded",
    max_context_length: (m.ctx || 32768) * 2,
    ...(isLoaded ? { loaded_context_length: m.ctx || 32768 } : {}),
    capabilities: m.toolUse === false ? [] : ["tool_use"],
  });

  const allModels = () => [
    ...state.loaded.map((m) => entry(m, true)),
    ...state.downloaded.filter((d) => !state.loaded.some((l) => l.id === d.id)).map((m) => entry(m, false)),
  ];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url.split("?")[0];
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "POST" && url === "/__mock/lms") {
        let cmd = "";
        try { cmd = JSON.parse(body).command || ""; } catch { /* ignore */ }
        return json(200, runLms(cmd));
      }
      if (req.method === "GET" && url === "/api/v0/models") {
        probes++;
        if (state.flip) {
          if (state.flip.remaining <= 0) { state.loaded = [...state.flip.loaded]; state.flip = null; }
          else state.flip.remaining--;
        }
        return json(200, { object: "list", data: allModels() });
      }
      if (req.method === "GET" && url.startsWith("/api/v0/models/")) {
        const id = decodeURIComponent(url.slice("/api/v0/models/".length));
        const m = allModels().find((x) => x.id === id);
        return m ? json(200, m) : json(404, { error: "model not found" });
      }
      if (req.method === "GET" && url === "/v1/models") {
        return json(200, { object: "list", data: allModels().map((m) => ({ id: m.id, object: "model", owned_by: "mock" })) });
      }

      if (req.method === "POST" && url === "/v1/chat/completions") {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        // Record at ARRIVAL: which model was requested, and what was loaded at that instant.
        completions.push({
          at: Date.now(),
          model: parsed.model,
          loadedAtRequest: state.loaded.map((m) => m.id),
          messages: parsed.messages || [],
        });
        const reply = () => answerCompletion(parsed, res, json, completions.length);
        if (state.completionDelayMs > 0) return void setTimeout(reply, state.completionDelayMs); // simulate a slow model
        return reply();
      }

      unknown.push(`${req.method} ${url}`);
      return json(404, { error: `mock-lmstudio: unhandled ${req.method} ${url}` });
    });
  });

  function answerCompletion(parsed, res, json, n) {
    if (res.destroyed || res.writableEnded) return; // client gave up (e.g. a cancelled turn)
    {
        const text = `MOCK-REPLY from ${parsed.model}`;
        const id = `chatcmpl-mock-${n}`;
        const created = Math.floor(Date.now() / 1000);
        const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
        if (parsed.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          const chunk = (delta, finish) =>
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          res.write(chunk({ role: "assistant", content: "" }, null));
          res.write(chunk({ content: text }, null));
          res.write(chunk({}, "stop"));
          if (parsed.stream_options && parsed.stream_options.include_usage) {
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: parsed.model, choices: [], usage })}\n\n`);
          }
          res.end("data: [DONE]\n\n");
          return;
        }
        return json(200, {
          id, object: "chat.completion", created, model: parsed.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage,
        });
    }
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        completions,
        unknown,
        loads,
        unloads,
        get probes() { return probes; },
        loadedIds: () => state.loaded.map((m) => m.id),
        setLoaded: (models) => { state.loaded = [...models]; },
        setFailLoad: (v) => { state.failLoad = !!v; },
        setCompletionDelay: (ms) => { state.completionDelayMs = ms; },
        /** The next `n` /api/v0/models probes see today's state; every later one sees `models` loaded. */
        flipAfterProbes: (n, models) => { state.flip = { remaining: n, loaded: [...models] }; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}
