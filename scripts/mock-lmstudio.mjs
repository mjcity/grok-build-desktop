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
  const state = { loaded: [...loaded], downloaded: [...downloaded] };
  const completions = [];
  const unknown = [];

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

      if (req.method === "GET" && url === "/api/v0/models") return json(200, { object: "list", data: allModels() });
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
        completions.push({
          at: Date.now(),
          model: parsed.model,
          loadedAtRequest: state.loaded.map((m) => m.id),
          messages: parsed.messages || [],
        });
        const text = `MOCK-REPLY from ${parsed.model}`;
        const id = `chatcmpl-mock-${completions.length}`;
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

      unknown.push(`${req.method} ${url}`);
      return json(404, { error: `mock-lmstudio: unhandled ${req.method} ${url}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        completions,
        unknown,
        setLoaded: (models) => { state.loaded = [...models]; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
