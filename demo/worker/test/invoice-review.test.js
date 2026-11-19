import { expect, it } from "vitest";
import { handle } from "../src/index.js";
import { sign } from "../src/tokens.js";
import { makeTestDeps, SECRET } from "./helpers.js";

const RECORDS = {
  purchase_order: { id: "PO-1842", units: 100, unit_price_usd: 45 },
  goods_receipt: { id: "GR-1842", purchase_order_id: "PO-1842", units: 100, unit_price_usd: 45 },
};

async function recordingSession() {
  const { deps } = makeTestDeps({ vars: {
    MANUAL_UPSTREAM_URL: "http://127.0.0.1:18080",
    MANUAL_UPSTREAM_KEY: "machine-key",
    MANUAL_INVOICE_MCP_URL: "http://127.0.0.1:8765/mcp",
    CHAT_MODELS: "fast:Qwen3.8-27B,deep:Qwen3.8-Flash-Next",
  } });
  const cookie = `locus_demo=${await sign(SECRET, { p: "session", d: "manual", exp: Math.floor(deps.now() / 1000) + 3600 })}`;
  return {
    deps,
    status: (origin) => handle(new Request(`${origin}/api/demo/status`, { headers: { cookie } }), deps),
    review: (origin, mode = true) => handle(new Request(`${origin}/api/demo/chat`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ invoice_review: mode, model: mode === true ? "deep" : "fast", messages: [{ role: "user", content: "browser-provided text" }] }),
    }), deps),
  };
}

it.each([
  { mode: true, model: "fast", calls: ["model", "tools/call", "stream"] },
  { mode: "resolution", model: "deep", calls: ["tools/call", "stream"] },
])("streams the $model answer with the sample records retrieved through MCP", async ({ mode, model, calls: expectedCalls }) => {
  const { deps, status, review } = await recordingSession();
  const origin = "http://127.0.0.1:5174";
  expect(await (await status(origin)).json()).toMatchObject({ invoice_review: true });
  const calls = [];
  deps.fetchFn = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith("/mcp")) {
      calls.push(body.method);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result;
      if (body.method === "initialize") result = { protocolVersion: "2025-03-26" };
      if (body.method === "tools/list") result = { tools: [{ name: "get_purchase_order", inputSchema: { type: "object" } }] };
      if (body.method === "tools/call") {
        expect(body.params).toEqual({ name: "get_purchase_order", arguments: { purchase_order_id: "PO-1842" } });
        result = { content: [{ type: "text", text: JSON.stringify(RECORDS) }] };
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    calls.push(body.stream ? "stream" : "model");
    expect(body.model).toBe(model);
    expect(JSON.stringify(body.messages)).not.toContain("browser-provided text");
    if (!body.stream) {
      expect(body.tools[0].function.name).toBe("get_purchase_order");
      return Response.json({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: "lookup", type: "function", function: {
          name: "get_purchase_order", arguments: JSON.stringify({ purchase_order_id: "PO-1842" }),
        } }],
      } }] });
    }
    const last = body.messages.at(-1);
    if (model === "fast") {
      expect(last).toMatchObject({ role: "tool", tool_call_id: "lookup" });
      expect(JSON.parse(last.content).goods_receipt.id).toBe("GR-1842");
    } else {
      expect(last.content).toContain("GR-1842");
      expect(last.content).toContain("Draft a short email");
      expect(last.content).toContain("holding invoice");
    }
    return new Response('data: {"choices":[{"delta":{"content":"$900"}}]}\n\ndata: [DONE]\n\n');
  };
  const res = await review(origin, mode);
  expect(res.status).toBe(200);
  const stream = await res.text();
  expect(stream).toContain('"invoice_sources"');
  expect(stream.indexOf("GR-1842")).toBeLessThan(stream.indexOf("$900"));
  expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list", ...expectedCalls]);
});

it("keeps invoice review disabled on non-local requests", async () => {
  const { deps, status, review } = await recordingSession();
  deps.fetchFn = async () => { throw new Error("Tool requests should be gated"); };
  const origin = "https://site.test";
  expect((await (await status(origin)).json()).invoice_review).toBeUndefined();
  expect((await review(origin)).status).toBe(403);
  expect((await review(origin, "resolution")).status).toBe(403);
});
