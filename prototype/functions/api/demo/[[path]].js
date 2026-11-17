// /api/demo/*: everything about the live demo (request, confirm, status, chat).
// The logic lives in a separate Worker, locus-demo (demo/worker/), because Pages cannot run
// scheduled jobs or Workflows. This file only hands each request over to it through the service
// binding DEMO (see wrangler.jsonc) and hands the answer back untouched: method, body and cookies
// in; status, Set-Cookie, redirects and the streamed chat out.

const reply = (data, status) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequest({ request, env }) {
  if (!env.DEMO) {
    console.error("demo not reachable: bind the locus-demo Worker as DEMO");
    return reply({ ok: false, error: "The live demo is not set up yet." }, 503);
  }
  try {
    // redirect: "manual", so the confirmation link's redirect (and its cookie) reaches the browser
    return await env.DEMO.fetch(new Request(request, { redirect: "manual" }));
  } catch (err) {
    console.error("demo Worker failed:", err);
    return reply({ ok: false, error: "The live demo is not answering. Please try again in a minute." }, 502);
  }
}
