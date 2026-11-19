import { invoice, invoiceText, MATCH_INVOICE, REVIEW_BEFORE_PAYMENT } from "../../../prototype/shared/invoice.js";
import { fail } from "./http.js";
import { isLoopback } from "./recording.js";

const TOOL = "get_purchase_order";
const PROTOCOL = "2025-03-26";

export function localInvoiceMcp(request, cfg) {
  if (!isLoopback(new URL(request.url)) || !cfg.chatModels.some(({ id }) => id === "fast")) return null;
  try {
    const url = new URL(cfg.manual.invoiceMcpUrl);
    return url.protocol === "http:" && isLoopback(url) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

async function purchaseOrderTool(fetchFn, url, signal) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
  };
  let id = 0;
  async function rpc(method, params, notification = false) {
    const response = await fetchFn(url, {
      method: "POST", headers, signal, redirect: "manual",
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params }),
    });
    if (!response.ok) throw new Error("Purchase-order MCP request failed");
    if (notification) return;
    const reply = await response.json();
    if (reply.error || reply.id !== id || !reply.result) throw new Error("Invalid purchase-order MCP response");
    return reply.result;
  }
  const init = await rpc("initialize", {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "locus", version: "1" },
  });
  if (init.protocolVersion !== PROTOCOL) throw new Error("Unsupported purchase-order MCP protocol");
  await rpc("notifications/initialized", {}, true);
  const { tools } = await rpc("tools/list", {});
  const tool = tools?.find(({ name }) => name === TOOL);
  if (!tool?.inputSchema) throw new Error("Purchase-order tool unavailable");
  return { tool, call: (args) => rpc("tools/call", { name: TOOL, arguments: args }) };
}

function invoiceSources(data) {
  if (data.isError) throw new Error("Purchase-order lookup failed");
  const record = data.structuredContent ?? JSON.parse(data.content.find(({ type }) => type === "text").text);
  const { purchase_order: po, goods_receipt: receipt } = record;
  const valid = (row) => Number.isSafeInteger(row?.units) && row.units >= 0 &&
    Number.isFinite(row.unit_price_usd) && row.unit_price_usd >= 0;
  if (!valid(po) || !valid(receipt) || po.id !== invoice.purchaseOrder ||
      receipt.purchase_order_id !== po.id || !/^GR-\d+$/.test(receipt.id)) {
    throw new Error("Purchase-order records did not match the invoice");
  }
  return {
    purchase_order: { id: po.id, units: po.units, unit_price_usd: po.unit_price_usd },
    goods_receipt: { id: receipt.id, units: receipt.units, unit_price_usd: receipt.unit_price_usd },
  };
}

async function matchInvoice(mcp, complete) {
  const messages = [
    { role: "system", content: "Review the invoice using the purchase order and goods receipt. Call get_purchase_order before answering. After the lookup, answer in three short bullets reporting the billed amount, the quantities in both source records, and the discrepancy with arithmetic. Bold the discrepancy." },
    { role: "user", content: `${invoiceText}\n\n${MATCH_INVOICE}` },
  ];
  const tool = { type: "function", function: { name: TOOL, description: mcp.tool.description, parameters: mcp.tool.inputSchema } };
  const response = await complete({ messages, tools: [tool], stream: false, max_tokens: 256 });
  if (!response.ok) throw new Error("The model could not start the purchase-order lookup");
  const reply = (await response.json()).choices?.[0]?.message;
  const calls = reply?.tool_calls;
  const call = calls?.[0];
  if (calls?.length !== 1 || !call.id || call.function?.name !== TOOL) throw new Error("The model did not request a purchase order");
  const args = JSON.parse(call.function.arguments);
  if (args?.purchase_order_id !== invoice.purchaseOrder) throw new Error("The model requested a different purchase order");
  const sources = invoiceSources(await mcp.call({ purchase_order_id: args.purchase_order_id }));
  messages.push(
    { role: "assistant", content: reply.content, tool_calls: calls },
    { role: "tool", tool_call_id: call.id, content: JSON.stringify(sources) },
  );
  return { sources, params: { messages, tools: [tool], tool_choice: "none" } };
}

async function reviewBeforePayment(mcp) {
  const sources = invoiceSources(await mcp.call({ purchase_order_id: invoice.purchaseOrder }));
  const messages = [
    { role: "system", content: "You assist accounts payable. In 120 words or fewer, assess the invoice against the purchase order and goods receipt and state the amount supported by the records. If the records agree, recommend sending the invoice through normal approval. If anything is missing or inconsistent, recommend holding the entire invoice pending verification and explain what would resolve the issue. Draft a short email only if information or a correction is needed from the supplier. Your review does not authorize payment." },
    { role: "user", content: `${invoiceText}\n\nPurchasing records:\n${JSON.stringify(sources)}\n\n${REVIEW_BEFORE_PAYMENT}` },
  ];
  return { sources, params: { messages } };
}

export async function reviewInvoice(request, deps, upstream, resolution) {
  const model = resolution ? "deep" : "fast";
  if (!upstream.invoiceMcp || !upstream.models.some(({ id }) => id === model)) {
    return fail(403, "Invoice review is unavailable for this session.");
  }
  const headers = { authorization: `Bearer ${upstream.key}`, "content-type": "application/json" };
  const modelBody = { model, temperature: 0, chat_template_kwargs: { [deps.cfg.thinkingKwarg]: false } };
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  const complete = (params) => deps.fetchFn(`${upstream.url}/v1/chat/completions`, {
    method: "POST", headers, signal, body: JSON.stringify({ ...modelBody, ...params }),
  });

  try {
    const mcp = await purchaseOrderTool(deps.fetchFn, upstream.invoiceMcp, signal);
    const { sources, params } = await (resolution ? reviewBeforePayment(mcp) : matchInvoice(mcp, complete));
    const answer = await complete({ ...params, stream: true, max_tokens: Math.min(600, deps.cfg.chatMaxTokens) });
    if (!answer.ok || !answer.body) throw new Error("The model could not finish the invoice review");
    const sourceEvent = new TextEncoder().encode(`data: ${JSON.stringify({ invoice_sources: sources })}\n\n`);
    const withSources = new TransformStream({ start(controller) { controller.enqueue(sourceEvent); } });
    return new Response(answer.body.pipeThrough(withSources), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("invoice review", error?.name, error?.message);
    return fail(502, "The purchase-order review couldn’t finish. Try again.");
  }
}
