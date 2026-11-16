// Vast.ai REST client (https://docs.vast.ai/api-reference/, checked 2026-11-16).
//   search offers:   POST /api/v0/bundles            (filters as { field: { op: value } }; cpu_ram in MB)
//   create instance: PUT  /api/v0/asks/{offer_id}/   (env + ports in one docker-flag string; returns new_contract)
//   show instance:   GET  /api/v0/instances/{id}     ({ instances: {…} }; actual_status)
//   list instances:  GET  /api/v1/instances          (limit ≤ 25, after_token = previous next_token)
//   destroy:         DELETE /api/v0/instances/{id}
// We never read the instance `ports` field: the demo is reached through a Cloudflare tunnel.

import { fetchJson, HttpError } from "./http.js";

const BASE = "https://console.vast.ai";

/** Builds the docker-flag env string. Values are double-quoted; quotes/newlines are refused. */
export function envString(vars) {
  return Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`);
      const s = String(v);
      if (/["\n\r\\]/.test(s)) throw new Error(`env ${k} contains a quote, backslash or newline`);
      return /\s/.test(s) ? `-e ${k}="${s}"` : `-e ${k}=${s}`;
    })
    .join(" ");
}

export function vastClient({ apiKey, fetchFn = fetch }) {
  const call = (path, init = {}) => {
    if (!apiKey) throw new Error("VAST_API_KEY is not set");
    return fetchJson(fetchFn, `${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...init.headers } });
  };
  return {
    async searchOffers(query) {
      const body = await call("/api/v0/bundles", { method: "POST", body: JSON.stringify(query) });
      const offers = body?.offers;
      return Array.isArray(offers) ? offers : offers ? [offers] : [];
    },
    async createInstance(offerId, spec) {
      const body = await call(`/api/v0/asks/${Number(offerId)}/`, { method: "PUT", body: JSON.stringify(spec) });
      if (!body?.success || !body.new_contract) throw new Error(`create instance failed: ${JSON.stringify(body).slice(0, 200)}`);
      return { instanceId: Number(body.new_contract) };
    },
    async getInstance(id) {
      try {
        const body = await call(`/api/v0/instances/${Number(id)}`);
        return body?.instances ?? null;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
    },
    async listInstances({ maxPages = 8 } = {}) {
      const out = [];
      let after = null;
      const cols = encodeURIComponent(JSON.stringify(["id", "label", "actual_status", "start_date", "machine_id"]));
      for (let i = 0; i < maxPages; i++) {
        const body = await call(`/api/v1/instances?limit=25&select_cols=${cols}${after ? `&after_token=${encodeURIComponent(after)}` : ""}`);
        out.push(...(body?.instances ?? []));
        after = body?.next_token;
        if (!after) break;
      }
      return out;
    },
    async destroyInstance(id) {
      try {
        await call(`/api/v0/instances/${Number(id)}`, { method: "DELETE" });
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false; // already gone
        throw err;
      }
    },
  };
}
