import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { handle } from "../src/index.js";
import { getDemo } from "../src/db.js";
import { screen } from "../src/pipeline.js";
import { fakeOpenAI } from "../src/fakes.js";
import { resetDb, makeTestDeps, postJson, req, cookieFrom } from "./helpers.js";

const linkIn = (text) => text.match(/https:\/\/site\.test(\/api\/demo\/\S+)/)[1];
const ask = (deps, email, extra = {}) => handle(postJson("/api/demo/request", { email, company_website: "", turnstile_token: "pass", page: "/", ...extra }, { "cf-connecting-ip": "1.2.3.4" }), deps);

describe("request -> confirm -> checks -> status", () => {
  beforeEach(resetDb);

  it("happy path: email with link, confirm sets the cookie, checks approve, status reports booting", async () => {
    const { deps, created } = makeTestDeps();
    const r = await ask(deps, "Jane@ACME-Industries.com");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(deps.email.sent).toHaveLength(1);
    expect(deps.email.sent[0].to).toBe("jane@acme-industries.com");

    const confirmUrl = linkIn(deps.email.sent[0].text);
    const c = await handle(req(confirmUrl), deps);
    expect(c.status).toBe(302);
    expect(c.headers.get("location")).toBe("/demo");
    const setCookie = c.headers.get("set-cookie");
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(created.checks).toHaveLength(1);
    const cookie = cookieFrom(c);

    let s = await (await handle(req("/api/demo/status", { headers: { cookie } }), deps)).json();
    expect(s).toMatchObject({ ok: true, status: "checking" });

    const demoId = created.checks[0].params.demoId;
    expect(await screen(deps, demoId)).toBe("booting");
    s = await (await handle(req("/api/demo/status", { headers: { cookie } }), deps)).json();
    expect(s).toMatchObject({ status: "booting", step: "reserving" });

    // the confirmation link is single-use
    const again = await handle(req(confirmUrl), deps);
    expect(again.headers.get("location")).toBe("/demo?link=used");
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("no cookie means status none", async () => {
    const { deps } = makeTestDeps();
    expect(await (await handle(req("/api/demo/status"), deps)).json()).toEqual({ ok: true, status: "none" });
  });

  it("refuses free/disposable mail, bad emails, failed Turnstile; honeypot looks like success", async () => {
    const { deps } = makeTestDeps();
    expect((await ask(deps, "jane@gmail.com")).status).toBe(400);
    expect((await ask(deps, "jane@mailinator.com")).status).toBe(400);
    expect((await ask(deps, "not-an-email")).status).toBe(400);
    expect((await ask(deps, "jane@acme-industries.com", { turnstile_token: "nope" })).status).toBe(400);
    const hp = await ask(deps, "bot@acme-industries.com", { company_website: "http://spam" });
    expect(hp.status).toBe(200);
    expect(deps.email.sent).toHaveLength(0);
  });

  it("enforces caps at request time: per email, per IP", async () => {
    const { deps } = makeTestDeps();
    await ask(deps, "jane@acme-industries.com");
    await handle(req(linkIn(deps.email.sent[0].text)), deps); // confirmed
    const second = await ask(deps, "jane@acme-industries.com");
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/7 days/);
    const { deps: d2 } = makeTestDeps();
    for (let i = 0; i < 4; i++) await ask(d2, `u${i}@company${i}.com`);
    expect((await ask(d2, "u9@company9.com")).status).toBe(400); // 6th from the same IP within the hour
  });

  it("a homepage injection lands in review; the owner's approve link admits it, once", async () => {
    const { deps, created } = makeTestDeps({ openai: fakeOpenAI({ decision: "approve" }) });
    await ask(deps, "ceo@injection-corp.com");
    await handle(req(linkIn(deps.email.sent[0].text)), deps);
    const id = created.checks[0].params.demoId;
    expect(await screen(deps, id)).toBe("review");
    const ownerMail = deps.email.sent.find((m) => m.to === "owner@locus.test");
    expect(ownerMail.text).toMatch(/AI screener/);
    const approve = ownerMail.text.match(/Approve: https:\/\/site\.test(\S+)/)[1];
    const reject = ownerMail.text.match(/Reject:  https:\/\/site\.test(\S+)/)[1];
    expect((await handle(req(approve), deps)).status).toBe(200);
    expect((await getDemo(env.DB, id)).status).toBe("booting");
    expect((await getDemo(env.DB, id)).decided_by).toBe("owner");
    expect(created.provision).toHaveLength(1);
    const late = await (await handle(req(reject), deps)).text();
    expect(late).toMatch(/Already decided/);
    expect((await handle(req(approve.replace("action=approve", "action=reject")), deps)).status).toBe(400); // action must match the signed one
  });

  it("owner reject link rejects", async () => {
    const { deps, created } = makeTestDeps();
    await ask(deps, "x@brandnew-startup.com");
    await handle(req(linkIn(deps.email.sent[0].text)), deps);
    const id = created.checks[0].params.demoId;
    expect(await screen(deps, id)).toBe("review");
    const reject = deps.email.sent.at(-1).text.match(/Reject:  https:\/\/site\.test(\S+)/)[1];
    await handle(req(reject), deps);
    expect((await getDemo(env.DB, id)).status).toBe("rejected");
  });

  it("unknown routes 404, missing secret 503", async () => {
    const { deps } = makeTestDeps();
    expect((await handle(req("/api/demo/nope"), deps)).status).toBe(404);
    const { deps: bad } = makeTestDeps({ vars: { SIGNING_SECRET: "" } });
    expect((await handle(req("/api/demo/status"), bad)).status).toBe(503);
  });
});

describe("manual mode (Phase 2)", () => {
  const vars = {
    MANUAL_UPSTREAM_URL: "https://manual-box.example/",
    MANUAL_UPSTREAM_KEY: "box-key",
    MANUAL_ACCESS_KEY: "open-sesame-open-sesame",
    MANUAL_ENDS_AT: "2026-11-16T14:00:00Z",
    MANUAL_HW_CPU: "AMD EPYC 9654",
    MANUAL_HW_RAM_GB: "256",
  };

  it("secret link gives an immediately ready session against the configured machine", async () => {
    const { deps, llama } = makeTestDeps({ vars });
    expect((await handle(req("/api/demo/manual?key=wrong-wrong-wrong-wrong"), deps)).status).toBe(404);
    const r = await handle(req("/api/demo/manual?key=open-sesame-open-sesame"), deps);
    expect(r.status).toBe(302);
    const cookie = cookieFrom(r);
    const s = await (await handle(req("/api/demo/status", { headers: { cookie } }), deps)).json();
    expect(s).toEqual({ ok: true, status: "ready", ends_at: "2026-11-16T14:00:00.000Z", hardware: { cpu: "AMD EPYC 9654", ram_gb: 256, gpu: "1× RTX 5090" }, model: "Qwen3.8-Flash-Next" });
    const chat = await handle(postJson("/api/demo/chat", { messages: [{ role: "user", content: "hi" }], thinking: false }, { cookie }), deps);
    expect(chat.status).toBe(200);
    await chat.text();
    expect(llama.calls[0].auth).toBe("Bearer box-key");
  });

  it("lists the models when CHAT_MODELS is set, and forwards the pick to the machine", async () => {
    const { deps, llama } = makeTestDeps({ vars: { ...vars, CHAT_MODELS: "auto:Auto,deep:Qwen3.8-Flash-Next,fast:Qwen3.8-27B" } });
    const cookie = cookieFrom(await handle(req("/api/demo/manual?key=open-sesame-open-sesame"), deps));
    const s = await (await handle(req("/api/demo/status", { headers: { cookie } }), deps)).json();
    expect(s).toMatchObject({ status: "ready", model: "Qwen3.8-Flash-Next" });
    expect(s.models.map((m) => m.id)).toEqual(["auto", "deep", "fast"]);
    const chat = await handle(postJson("/api/demo/chat", { messages: [{ role: "user", content: "hi" }], model: "deep" }, { cookie }), deps);
    expect(chat.status).toBe(200);
    await chat.text();
    expect(llama.calls[0].body.model).toBe("deep");
  });

  it("is off without the upstream vars, and ends at MANUAL_ENDS_AT", async () => {
    const { deps } = makeTestDeps();
    expect((await handle(req("/api/demo/manual?key=open-sesame-open-sesame"), deps)).status).toBe(404);
    const { deps: d2, clock } = makeTestDeps({ vars });
    const cookie = cookieFrom(await handle(req("/api/demo/manual?key=open-sesame-open-sesame"), d2));
    clock.t = Date.parse("2026-11-16T14:00:01Z");
    expect((await (await handle(req("/api/demo/status", { headers: { cookie } }), d2)).json()).status).toBe("ended");
    expect((await handle(postJson("/api/demo/chat", { messages: [{ role: "user", content: "hi" }] }, { cookie }), d2)).status).toBe(409);
  });
});
