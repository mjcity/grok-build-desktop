#!/usr/bin/env node
/**
 * Local MCP server giving Grok real desktop computer-use: screenshot, click,
 * type, scroll, drag, hotkeys. Wired into GrokBuild.cmd the same way as the
 * Playwright MCP server (URL-mode entry in ~/.grok/config.toml).
 *
 * WHY THIS SHAPE (researched 2026-07-21 before building, see project memory):
 * UI-TARS-desktop ships no ready-made MCP server for GUI control (only
 * browser/commands/filesystem/search MCP servers exist upstream) and its
 * GUIAgent class couples the loop to a model that emits UI-TARS's own action
 * grammar. Neither is needed here. `NutJSOperator` (from
 * @ui-tars/operator-nut-js) has exactly two public methods with ZERO model
 * coupling:
 *
 *   screenshot() -> { base64, scaleFactor }   (logical/CSS-pixel size image;
 *                                              real @computer-use/nut-js
 *                                              screen capture under the hood)
 *   execute({ parsedPrediction: { action_type, action_inputs },
 *             screenWidth, screenHeight, scaleFactor, factors })
 *
 * `execute()` is plain data in, no LLM call inside it. So Grok itself (a
 * vision-capable model) looks at the screenshot tool's image, decides pixel
 * coordinates, and this server's tools translate those plain args directly
 * into the `parsedPrediction` shape below — no UI-TARS model, no
 * action-parser, no adapter class. This is the entire reason the build is
 * small: we use the operator purely as "hands," never its "brain."
 *
 * Coordinate math (read from @ui-tars/sdk's parseBoxToScreenCoords source):
 * start_box/end_box strings are FRACTIONS of screenWidth/screenHeight
 * (0.0-1.0), not raw pixels and not a 0-1000 model grid despite
 * DEFAULT_FACTORS=[1000,1000] (that factor only adds rounding precision,
 * verified by reading the actual arithmetic). So a click at pixel (x, y)
 * becomes start_box = "[x/screenWidth, y/screenHeight, x/screenWidth,
 * y/screenHeight]" - a zero-size box, which the parser reduces to its own
 * center, i.e. exactly (x, y) again.
 *
 * Windows note: NutJSOperator's own `type` action already special-cases
 * win32 (copies text to clipboard, sends Ctrl+V, restores clipboard) instead
 * of naive keystroke typing - this was ByteDance's own fix for slow/lossy
 * Windows key-event typing, not something this server needed to add.
 */

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { NutJSOperator } from "@ui-tars/operator-nut-js";
import { screen } from "@computer-use/nut-js";

const PORT = Number(process.env.COMPUTER_USE_MCP_PORT || 8932);
const HOST = "127.0.0.1";

const operator = new NutJSOperator();

// Cached only for the duration of one screenshot->action pair, never across
// unrelated calls - screen resolution can change (display hot-plug, DPI
// change) and a stale cache would silently mis-click.
let lastScreenshot = null; // { width, height, scaleFactor, atMs }
const SCREENSHOT_STALE_MS = 5 * 60 * 1000;

function log(...args) {
  console.log(`[computer-use-mcp]`, ...args);
}

async function getLogicalScreenSize() {
  // Logical (CSS-pixel-equivalent) size - same space the screenshot image
  // and execute()'s screenWidth/screenHeight expect. nut-js's screen.width()/
  // height() already return logical size (matches what NutJSOperator.
  // screenshot() computes internally by dividing physical size by
  // pixelDensity.scaleX/Y).
  const [width, height] = await Promise.all([screen.width(), screen.height()]);
  return { width, height };
}

function fractionBox(x, y, width, height) {
  const fx = Math.min(1, Math.max(0, x / width));
  const fy = Math.min(1, Math.max(0, y / height));
  return `[${fx}, ${fy}, ${fx}, ${fy}]`;
}

async function execute(actionType, actionInputs) {
  if (!lastScreenshot || Date.now() - lastScreenshot.atMs > SCREENSHOT_STALE_MS) {
    // Never guess screen size for a real action off a stale/missing
    // screenshot - refresh it ourselves rather than fail the tool call.
    const size = await getLogicalScreenSize();
    lastScreenshot = { ...size, scaleFactor: 1, atMs: Date.now() };
  }
  const { width, height, scaleFactor } = lastScreenshot;
  return operator.execute({
    parsedPrediction: { action_type: actionType, action_inputs: actionInputs, reflection: null, thought: "" },
    screenWidth: width,
    screenHeight: height,
    scaleFactor,
    factors: [1000, 1000],
  });
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function buildServer() {
  const server = new McpServer(
    { name: "grok-build-computer-use", version: "0.1.0" },
    { capabilities: {} }
  );

  server.registerTool(
    "computer_screenshot",
    {
      description:
        "Take a screenshot of the current desktop. Returns the image plus its logical pixel width/height - use those exact pixel coordinates (not fractions) in click/type/scroll calls.",
      inputSchema: {},
    },
    async () => {
      const shot = await operator.screenshot(); // { base64, scaleFactor }
      const size = await getLogicalScreenSize();
      lastScreenshot = { ...size, scaleFactor: shot.scaleFactor, atMs: Date.now() };
      log(`screenshot ${size.width}x${size.height} scaleFactor=${shot.scaleFactor}`);
      return {
        content: [
          {
            type: "image",
            data: shot.base64,
            mimeType: "image/png",
          },
          {
            type: "text",
            text: `${size.width}x${size.height} logical pixels. Use these pixel coordinates directly in computer_click/computer_type/computer_scroll/computer_drag.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "computer_click",
    {
      description:
        "Click at pixel coordinates from the most recent computer_screenshot. button defaults to left; double for a double-click.",
      inputSchema: {
        x: z.number().describe("Pixel x from the last screenshot"),
        y: z.number().describe("Pixel y from the last screenshot"),
        button: z.enum(["left", "right", "middle"]).default("left"),
        double: z.boolean().default(false).describe("Double-click instead of single"),
      },
    },
    async ({ x, y, button, double }) => {
      if (!lastScreenshot) {
        return textResult("Call computer_screenshot first so click coordinates map to the current screen size.");
      }
      const box = fractionBox(x, y, lastScreenshot.width, lastScreenshot.height);
      const actionType = double ? "double_click" : button === "right" ? "right_click" : button === "middle" ? "middle_click" : "click";
      await execute(actionType, { start_box: box });
      log(`${actionType} at (${x}, ${y})`);
      return textResult(`${actionType} at (${x}, ${y})`);
    }
  );

  server.registerTool(
    "computer_type",
    {
      description:
        "Type text at the current focus/cursor. On Windows this pastes via clipboard (fast, reliable for unicode) rather than sending individual keystrokes. End text with \\n to also press Enter.",
      inputSchema: {
        text: z.string(),
      },
    },
    async ({ text }) => {
      await execute("type", { content: text });
      log(`type ${JSON.stringify(text.slice(0, 60))}${text.length > 60 ? "..." : ""}`);
      return textResult(`typed ${text.length} chars`);
    }
  );

  server.registerTool(
    "computer_hotkey",
    {
      description:
        'Press a key combo, e.g. "ctrl+c", "ctrl+shift+t", "alt+F4", "win", "return". Space or + separated.',
      inputSchema: {
        keys: z.string(),
      },
    },
    async ({ keys }) => {
      await execute("hotkey", { key: keys });
      log(`hotkey ${keys}`);
      return textResult(`pressed ${keys}`);
    }
  );

  server.registerTool(
    "computer_scroll",
    {
      description: "Scroll the mouse wheel at the given pixel coordinates.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        direction: z.enum(["up", "down"]),
      },
    },
    async ({ x, y, direction }) => {
      if (!lastScreenshot) {
        return textResult("Call computer_screenshot first so scroll coordinates map to the current screen size.");
      }
      const box = fractionBox(x, y, lastScreenshot.width, lastScreenshot.height);
      await execute("scroll", { start_box: box, direction });
      log(`scroll ${direction} at (${x}, ${y})`);
      return textResult(`scrolled ${direction} at (${x}, ${y})`);
    }
  );

  server.registerTool(
    "computer_drag",
    {
      description: "Drag from one pixel coordinate to another (press, move, release).",
      inputSchema: {
        startX: z.number(),
        startY: z.number(),
        endX: z.number(),
        endY: z.number(),
      },
    },
    async ({ startX, startY, endX, endY }) => {
      if (!lastScreenshot) {
        return textResult("Call computer_screenshot first so drag coordinates map to the current screen size.");
      }
      const { width, height } = lastScreenshot;
      const startBox = fractionBox(startX, startY, width, height);
      const endBox = fractionBox(endX, endY, width, height);
      await execute("drag", { start_box: startBox, end_box: endBox });
      log(`drag (${startX},${startY}) -> (${endX},${endY})`);
      return textResult(`dragged (${startX},${startY}) -> (${endX},${endY})`);
    }
  );

  server.registerTool(
    "computer_wait",
    {
      description: "Wait ~1 second, e.g. after triggering something that needs a moment to render.",
      inputSchema: {},
    },
    async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return textResult("waited 1s");
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    log("request error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// MCP streamable-HTTP is POST-only for this stateless server; GET/DELETE
// (session resumption / explicit teardown) are meaningless without server
// side session state, so reject them the same way the SDK's own stateless
// example does rather than silently 200-ing.
for (const method of ["get", "delete"]) {
  app[method]("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  });
}

app.listen(PORT, HOST, () => {
  log(`listening on http://localhost:${PORT}/mcp`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
