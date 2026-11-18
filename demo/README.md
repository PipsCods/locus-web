# demo

The live product demo: a verified visitor gets a rented server with one
RTX 5090 running Qwen3.8-Flash-Next in hybrid CPU/GPU mode, chats with it on
`/demo` for 2 hours, and the server is then destroyed.

It has three parts. The page lives with the rest of the site; the other two
live here.

| Part | Where | Runs on |
|---|---|---|
| Request form, progress and chat page | `prototype/demo.html`, `prototype/src/demo.js`, `prototype/src/demo.css` | Cloudflare Pages, with the site |
| Backend: checks, approval, spend caps, provisioning, teardown, chat proxy | [`worker/`](worker/README.md) | Cloudflare Worker `locus-demo` |
| Machine image, start script, benchmark | [`instance/`](instance/README.md) | the rented Vast.ai machine |

Benchmark results and the chosen runtime, quant and flags:
[`BENCHMARK.md`](BENCHMARK.md).

## How the parts connect

```
browser ──/api/demo/*──▶ Pages Function ──service binding DEMO──▶ Worker locus-demo
                         prototype/functions/api/demo/[[path]].js        │
                                                                         │ Vast API: rent, destroy
                                                                         │ Cloudflare API: tunnel + DNS
                                                                         ▼
                                    locus-demo-<id>.locus-ai.tech ──tunnel──▶ llama-server :8080
                                                                              (instance/onstart.sh)
```

On a tiered box, `:8080` is `instance/router.py` instead, in front of two
llama-servers on `:8081` (deep) and `:8082` (fast).

Two contracts hold the parts together. Change either side only together with
the other:

- **Browser ↔ Worker**: the `/api/demo/*` routes and their JSON, listed in
  [`worker/README.md`](worker/README.md#routes). The dev stand-in in
  `prototype/dev/demo-api.js` imitates them for `npm run dev`.
- **Worker ↔ machine**: the environment variables `onstart.sh` reads
  (`MODEL_REPO`, `MODEL_FILES`, `RUNTIME`, `LLAMA_ARGS`, `LLAMA_API_KEY`,
  `CF_TUNNEL_TOKEN`, `DEMO_TTL_SECONDS`; for a tiered box with two models
  behind `router.py`, `SERVERS` with per-server `<N>_*` variables and
  `ROUTER_*` instead of the first four), listed in
  [`instance/README.md`](instance/README.md#demo-machine-env-contract).

## Two sample reports

`prototype/public/demo/sample-report.txt` (Norrvik Instruments) is the example
visitors load on the page. `instance/prompts/sample-report.txt` (Kestrel Valve
& Pump Systems) is the one the benchmark's quality check uses, and the
results in `BENCHMARK.md` refer to it. Both are invented. They are kept apart
so that editing the page's example does not silently change what the recorded
benchmark measured.
