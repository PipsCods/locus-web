# Product demo recording

## Local walkthrough

Run `npm run dev` in `prototype/` and open
[`/demo?recording=1`](http://127.0.0.1:5173/demo?recording=1).
Select **Threadripper PRO 9995WX** and **Invoice review**, then enter
`locus-preview-2026`. The recommendation leads to a simulated reservation
and the locus invoice chat. Continue to **Try the two-model server**, pick
**Deep**, and ask which records to check. **Open Invoice Review preview**
opens the separate finance interface with the same invoice. Ask the
pre-filled question, then open the purchase order and goods receipt.

The EPYC option demonstrates an unavailable offer. Use a fresh browser
session with `&scenario=failed-start` to test a reservation error. Reload
during progress to resume the same preview reservation. The finance
interface and sample responses are served by Vite in development.

## Local booking path

The recording Worker uses local D1 and the existing provisioning Workflow.
Use a dedicated Wrangler state directory for recording and keep it across
restarts or takes so the booking journal survives. Define the selected Vast
offer and a spend ceiling before arming the take.

| Setting | Purpose |
|---|---|
| `RECORDING_TAKE_ID` | A unique name per armed take, up to 64 letters, digits, underscores or hyphens |
| `RECORDING_ACCESS_KEY` | Fixed password-manager value of at least 16 characters |
| `RECORDING_EXPIRES_AT` | Hard deadline as a UTC ISO 8601 timestamp |
| `RECORDING_OFFER_ID` | The exact Vast offer approved for the take. Optional with `DEV_FAKES=1` |
| `RECORDING_MAX_DPH` | Maximum USD per hour including the configured disk. Use prepaid credit for the overall budget including bandwidth |
| `SITE_URL` | The exact local Vite origin, for example `http://127.0.0.1:5173` |

Keep values in an ignored `.dev.vars.recording`. For a local fake Workflow
smoke test, start from `demo/worker/dev.vars.example`, leave `DEV_FAKES=1`,
and add the recording settings with a future deadline and a maximum hourly
price of at least `0.55`. Use the preview key above and set
`VAST_API_KEY=local-fake` if testing the sweep. The fake catalog has the
Threadripper offer.

```sh
# demo/worker/
npm run db:migrate:local -- --persist-to .wrangler/recording
npm run dev -- --ip 127.0.0.1 --env-file .dev.vars.recording --persist-to .wrangler/recording --test-scheduled

# prototype/ (in a separate terminal)
RECORDING_WORKER_URL=http://127.0.0.1:8787 npm run dev -- --host 127.0.0.1 --strictPort
```

After UI approval and rental authorization, configure the Vast and
Cloudflare credentials and the single-model settings from the
[Worker setup](../worker/README.md#setup). Build the image with
`--build-arg CUDA_ARCHITECTURES=86` and use the model files and flags
confirmed for the chosen host. Replace the fake settings with the
approved take configuration. Run the local sweep during the rehearsal
using Wrangler’s [scheduled test endpoint](../worker/README.md#local-development-and-tests).

A take writes its booking intent to D1 before calling Vast and sends at
most one create request. If Vast’s response is lost, reconciliation finds
the contract by its `locus-recording-<session>` label. Keep the same take
ID and D1 state when retrying or reconnecting. Before arming another take,
confirm the previous rental is gone in `vastai show instances` and remove
its recording tunnel and DNS record. Destroy the instance with
`vastai destroy instance <id> -y` as soon as the segment is captured.

## Two-model rehearsal and Open WebUI

Prefer 2× RTX 3090 on a DDR5 host. If using the rehearsed EPYC 7642 host,
show the rental’s actual hardware. Use the
[tiered machine settings](../instance/README.md#demo-machine-env-contract)
with these overrides from the rehearsal. Confirm shard paths and CPU
pinning for the booked host before starting it.

| Setting | Fast | Deep |
|---|---|---|
| Model | `unsloth/Qwen3.8-27B-GGUF` (`UD-Q4_K_XL`) | `unsloth/Qwen3.8-Flash-Next-GGUF` (`UD-IQ4_XS`) |
| Runtime | `mainline` | `ik` |
| GPU order | `1,0` | `0` |
| Slots × context | 8 × 16,384 | 1 × 32,768 |
| Rehearsed flags | `-ts 1,0 --kv-unified -fa on -ctk q8_0 -ctv q8_0 -t 4` | `-ncmoe 35 -t 42` |

Set `SERVERS="DEEP FAST"`, each model alias, `ROUTER_POLICY=fast-only`,
`ROUTER_DEFAULT=fast`, and `ROUTER_JUDGE=none`. Arm the absolute
`DEMO_EXPIRES_AT` before creating the rental. Use the existing
[manual session](../worker/README.md#manual-mode-phase-2-recording-the-video)
locally with actual hardware and `CHAT_MODELS=fast:Qwen3.8-27B,deep:Qwen3.8-Flash-Next`.
Omit `RECORDING_TAKE_ID` for this second Worker session and append
`?recording=tiered` to `/demo` after establishing the manual session.

Run the purchase-order MCP fixture with `uv run demo/recording/purchase_orders.py`
from the repo root. It exposes one read-only tool at
`http://127.0.0.1:8765/mcp`. Run Open WebUI on the same private network with
access to the MCP endpoint and the tiered router. For a containerized Open
WebUI, ensure the tool endpoint is reachable from the container through its
private network or host networking.

1. Add the router’s `/v1` base URL and API key as an OpenAI-compatible connection. Create **Invoice Review** with `fast` as its base model. [Open WebUI model connections](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/)
2. Add the MCP server through the admin Integrations screen as **MCP (Streamable HTTP)**. Enable native function calling and attach only `get_purchase_order` to the assistant. [Open WebUI MCP support](https://docs.openwebui.com/features/extensibility/mcp/)
3. Export the same fictional invoice for the attachment and ask “Does invoice INV-1042 match PO-1842 and the goods receipt?” in two fresh chats. Confirm each run called the tool for PO-1842 and used its results to flag $900. Open the source record in the capture.

```sh
# From the repo root
node --input-type=module -e 'import { invoiceText } from "./prototype/shared/invoice.js"; console.log(invoiceText)' > /tmp/INV-1042.txt
```

Use the same single-model session for the reservation and ready clips.
Check the final 1080p export for audio, visible source evidence and a
runtime under three minutes. Close the second rental and verify its
instance, tunnel and DNS record are gone.
