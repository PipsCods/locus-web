// Cloudflare API client for per-demo tunnels and DNS records (checked 2026-11-16).
//   create tunnel:  POST   /accounts/{a}/cfd_tunnel {name, config_src: "cloudflare"}
//   token:          GET    /accounts/{a}/cfd_tunnel/{id}/token -> result: "<token>"
//   ingress:        PUT    /accounts/{a}/cfd_tunnel/{id}/configurations {config: {ingress: [...]}}
//   list tunnels:   GET    /accounts/{a}/cfd_tunnel?include_prefix=…&is_deleted=false
//   connections:    DELETE /accounts/{a}/cfd_tunnel/{id}/connections   (needed before delete)
//   delete tunnel:  DELETE /accounts/{a}/cfd_tunnel/{id}
//   DNS:            POST/GET/DELETE /zones/{z}/dns_records   (proxied CNAME -> <id>.cfargotunnel.com)
// Token permissions: Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit.

import { fetchJson, HttpError } from "./http.js";

const BASE = "https://api.cloudflare.com/client/v4";

export function cloudflareClient({ apiToken, accountId, zoneId, fetchFn = fetch }) {
  const call = async (path, init = {}) => {
    if (!apiToken || !accountId || !zoneId) throw new Error("CF_API_TOKEN, CF_ACCOUNT_ID or CF_ZONE_ID is not set");
    const body = await fetchJson(fetchFn, `${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" } });
    if (body && body.success === false) throw new Error(`${path}: ${JSON.stringify(body.errors).slice(0, 200)}`);
    return body?.result;
  };
  const gone = (err) => err instanceof HttpError && err.status === 404;
  const a = `/accounts/${accountId}`;
  return {
    async findTunnel(name) {
      const list = await call(`${a}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
      return (list ?? []).find((t) => t.name === name) ?? null;
    },
    createTunnel: (name) => call(`${a}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name, config_src: "cloudflare" }) }),
    tunnelToken: (id) => call(`${a}/cfd_tunnel/${id}/token`),
    configureIngress: (id, hostname, service) =>
      call(`${a}/cfd_tunnel/${id}/configurations`, {
        method: "PUT",
        body: JSON.stringify({ config: { ingress: [{ hostname, service, originRequest: {} }, { service: "http_status:404" }] } }),
      }),
    listTunnels: (prefix) => call(`${a}/cfd_tunnel?include_prefix=${encodeURIComponent(prefix)}&is_deleted=false&per_page=1000`).then((r) => r ?? []),
    async deleteTunnel(id) {
      try {
        await call(`${a}/cfd_tunnel/${id}/connections`, { method: "DELETE" });
        await call(`${a}/cfd_tunnel/${id}`, { method: "DELETE" });
        return true;
      } catch (err) {
        if (gone(err)) return false;
        throw err;
      }
    },
    async findDns(name) {
      const list = await call(`/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`);
      return (list ?? [])[0] ?? null;
    },
    createDns: (name, tunnelId) =>
      call(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "CNAME", name, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "locus demo (auto-removed)" }),
      }),
    listDns: (prefix) => call(`/zones/${zoneId}/dns_records?type=CNAME&per_page=1000&name.startswith=${encodeURIComponent(prefix)}`).then((r) => r ?? []),
    async deleteDns(id) {
      try {
        await call(`/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" });
        return true;
      } catch (err) {
        if (gone(err)) return false;
        throw err;
      }
    },
  };
}
