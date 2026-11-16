import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { handle } from "../src/index.js";
import { createDemo, transition, updateDemo } from "../src/db.js";
import { sign } from "../src/tokens.js";
import { fakeLlama } from "../src/fakes.js";
import { resetDb, makeTestDeps, postJson, SECRET } from "./helpers.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");

async function readyDemo({ endsInMin = 60 } = {}) {
  const id = await createDemo(env.DB, { email: "a@acme-industries.com", domain: "acme-industries.com" }, NOW);
  await transition(env.DB, id, "checking", {}, { now: NOW });
  await transition(env.DB, id, "booting", {}, { now: NOW });
  await updateDemo(env.DB, id, { hostname: "locus-demo-x.demo.locus.test", api_key: "machine-key-123" }, NOW);
  await transition(env.DB, id, "ready", { ends_at: new Date(NOW + endsInMin * 60_000).toISOString() }, { now: NOW });
  return id;
}
const cookieFor = async (id) => `locus_demo=${await sign(SECRET, { p: "session", d: id, exp: NOW / 1000 + 3600 })}`;
const chatReq = (body, cookie, extra = {}) => postJson("/api/demo/chat", body, { ...(cookie ? { cookie } : {}), ...extra });
const MSGS = { messages: [{ role: "user", content: "Summarise the report." }], thinking: false };

describe("chat proxy", () => {
  beforeEach(resetDb);

  it("streams the upstream SSE through unchanged and adds the key server-side", async () => {
    const llama = fakeLlama({ key: "machine-key-123" });
    const { deps } = makeTestDeps({ llama });
    const id = await readyDemo();
    const res = await handle(chatReq({ ...MSGS, max_tokens: 999_999 }, await cookieFor(id)), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);
    const text = await res.text();
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"timings"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const call = llama.calls[0];
    expect(call.auth).toBe("Bearer machine-key-123");
    expect(call.body.stream).toBe(true);
    expect(call.body.max_tokens).toBe(deps.cfg.chatMaxTokens); // capped
    expect(call.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("maps thinking:true to the template switch and passes reasoning_content through", async () => {
    const llama = fakeLlama();
    const { deps } = makeTestDeps({ llama });
    const id = await readyDemo();
    const res = await handle(chatReq({ ...MSGS, thinking: true }, await cookieFor(id)), deps);
    expect(await res.text()).toContain("reasoning_content");
    expect(llama.calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("401 without a session, 409 when not ready or ended", async () => {
    const { deps } = makeTestDeps();
    expect((await handle(chatReq(MSGS), deps)).status).toBe(401);
    expect((await handle(chatReq(MSGS, "locus_demo=forged.token"), deps)).status).toBe(401);
    const id = await createDemo(env.DB, { email: "b@acme-industries.com", domain: "acme-industries.com" }, NOW);
    await transition(env.DB, id, "checking", {}, { now: NOW });
    expect((await handle(chatReq(MSGS, await cookieFor(id)), deps)).status).toBe(409);
    const ended = await readyDemo({ endsInMin: -1 });
    const r = await handle(chatReq(MSGS, await cookieFor(ended)), deps);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, error: expect.stringMatching(/ended/) });
  });

  it("413 for an oversized body, also when content-length lies", async () => {
    const { deps } = makeTestDeps({ vars: { CHAT_MAX_BODY_BYTES: "1000" } });
    const id = await readyDemo();
    const big = { messages: [{ role: "user", content: "x".repeat(5000) }] };
    expect((await handle(chatReq(big, await cookieFor(id)), deps)).status).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(big))); c.close(); } });
    const lying = new Request("https://site.test/api/demo/chat", { method: "POST", body: stream, duplex: "half", headers: { cookie: await cookieFor(id), "content-type": "application/json" } });
    expect((await handle(lying, deps)).status).toBe(413);
  });

  it("400 for malformed messages", async () => {
    const { deps } = makeTestDeps();
    const id = await readyDemo();
    for (const body of [{}, { messages: [] }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: 5 }] }]) {
      expect((await handle(chatReq(body, await cookieFor(id)), deps)).status).toBe(400);
    }
  });

  it("502 when the machine errors or is unreachable, without leaking the key", async () => {
    const { deps } = makeTestDeps({ llama: fakeLlama({ status: 500 }) });
    const id = await readyDemo();
    const r = await handle(chatReq(MSGS, await cookieFor(id)), deps);
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("machine-key");
    deps.fetchFn = async () => { throw new TypeError("connection refused"); };
    expect((await handle(chatReq(MSGS, await cookieFor(id)), deps)).status).toBe(502);
  });

  it("refuses cross-site posts", async () => {
    const { deps } = makeTestDeps();
    const id = await readyDemo();
    expect((await handle(chatReq(MSGS, await cookieFor(id), { origin: "https://evil.test" }), deps)).status).toBe(403);
  });
});
