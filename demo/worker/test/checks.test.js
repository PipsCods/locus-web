import { describe, it, expect } from "vitest";
import { blocklistGates, mxGate, domainAgeGate, websiteGate, runChecks, htmlToText, isFree, isDisposable, domainAndParents } from "../src/checks/index.js";
import { fakeNetFetch } from "../src/fakes.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const fetchFn = fakeNetFetch({ now: () => NOW });
const byName = (gates) => Object.fromEntries(gates.map((g) => [g.name, g]));

describe("mailbox blocklists", () => {
  it("flags free providers", () => {
    for (const d of ["gmail.com", "outlook.com", "yahoo.com", "proton.me", "gmx.ch"]) expect(isFree(d), d).toBe(true);
    expect(byName(blocklistGates("gmail.com")).free_mailbox.pass).toBe(false);
  });
  it("flags disposable providers, including their subdomains", () => {
    expect(isDisposable("mailinator.com")).toBe(true);
    expect(isDisposable("foo.mailinator.com")).toBe(true);
    expect(byName(blocklistGates("mailinator.com")).disposable_mailbox.pass).toBe(false);
  });
  it("passes company domains and does not match substrings", () => {
    for (const d of ["acme-industries.com", "migros.ch", "ethz.ch"]) {
      expect(isFree(d), d).toBe(false);
      expect(isDisposable(d), d).toBe(false);
    }
    expect(isFree("ail.com")).toBe(false);
    expect(isFree("gmail.com\nyahoo.com")).toBe(false);
  });
  it("lists parent domains", () => expect(domainAndParents("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]));
});

describe("network gates (fake DNS/RDAP/web)", () => {
  it("MX present / absent / nonexistent / null MX / error", async () => {
    expect((await mxGate("acme-industries.com", { fetchFn })).pass).toBe(true);
    expect((await mxGate("nomail-corp.com", { fetchFn })).pass).toBe(false);
    expect((await mxGate("does-not-exist.com", { fetchFn })).pass).toBe(false);
    const nullMx = async () => Response.json({ Status: 0, Answer: [{ type: 15, data: "0 ." }] });
    expect((await mxGate("x.com", { fetchFn: nullMx })).pass).toBe(false);
    const broken = async () => { throw new TypeError("down"); };
    expect((await mxGate("x.com", { fetchFn: broken })).pass).toBeNull();
  });

  it("domain age: old passes, young fails, unknown is null, subdomain falls back to parent", async () => {
    expect((await domainAgeGate("acme-industries.com", { fetchFn, now: NOW })).pass).toBe(true);
    const young = await domainAgeGate("brandnew-startup.com", { fetchFn, now: NOW });
    expect(young.pass).toBe(false);
    expect(young.days).toBe(10);
    expect((await domainAgeGate("unknown-tld.zz", { fetchFn, now: NOW })).pass).toBeNull();
    expect((await domainAgeGate("mail.acme-industries.com", { fetchFn, now: NOW })).pass).toBe(true);
  });

  it("website: reachable with text, bot wall counts as up, down fails", async () => {
    const ok = await websiteGate("acme-industries.com", { fetchFn });
    expect(ok.gate.pass).toBe(true);
    expect(ok.homepage).toMatch(/Precision machining/);
    const wall = async () => new Response("challenge", { status: 403 });
    expect((await websiteGate("x.com", { fetchFn: wall })).gate.pass).toBe(true);
    const down = async () => { throw new TypeError("connect failed"); };
    expect((await websiteGate("x.com", { fetchFn: down })).gate.pass).toBe(false);
  });

  it("htmlToText strips scripts and tags and caps length", () => {
    const t = htmlToText("<title>T</title><script>evil()</script><style>x{}</style><p>Hello &amp; <b>world</b></p>", 1000);
    expect(t).toContain("Title: T");
    expect(t).toContain("Hello & world");
    expect(t).not.toContain("evil");
    expect(htmlToText(`<p>${"a".repeat(10_000)}</p>`, 100).length).toBe(100);
  });

  it("runChecks skips the network for blocklisted domains", async () => {
    let calls = 0;
    const counting = async () => { calls++; return new Response(""); };
    const r = await runChecks("gmail.com", { fetchFn: counting });
    expect(calls).toBe(0);
    expect(byName(r.gates).free_mailbox.pass).toBe(false);
  });
});
