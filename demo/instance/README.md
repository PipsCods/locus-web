# demo/instance

Everything that runs on the rented Vast.ai machine: the image, the offer
search, the benchmark, and the demo start script.

| File | Runs where | What |
|---|---|---|
| `Dockerfile` | build machine | CUDA 13.0 image with ik_llama.cpp and mainline llama.cpp (sm_120), cloudflared, `hf`, `vastai` |
| `find-offer.sh` | your laptop | ranks 1x RTX 5090 offers, `--create` rents the best |
| `bench.sh` | rented machine | download + load timing, `-ncmoe`/threads sweep, prefill/generation speed, quality spot check |
| `onstart.sh` | rented machine | demo start: self-destruct timer, tunnel, download, server |
| `llama-wrapper.sh` | rented machine | `llama-server-ik`, `llama-server-mainline` (and `llama-bench-*`) |
| `prompts/` | rented machine | spot-check prompts and the synthetic report they use |

## Build and push the image

Needs Docker with BuildKit on an x86-64 machine. No GPU is needed to build.
Compiling the CUDA kernels three times (ik twice, mainline once) takes a
while; `--build-arg IK_CPU_VARIANTS=zen4` skips the AVX2 ik build if you will
only rent EPYC 9004/9005 or Sapphire Rapids hosts.

```sh
docker build -t ghcr.io/<you>/locus-instance:2026-11-16 demo/instance
docker push ghcr.io/<you>/locus-instance:2026-11-16
```

Build args: `IK_REF`, `MAINLINE_REF` (commit or tag), `CUDA_VERSION`
(default 13.0.3, the lowest CUDA that 5090 hosts on Vast report),
`CUDA_ARCHITECTURES` (120), `IK_CPU_VARIANTS` ("v3 zen4"),
`CLOUDFLARED_VERSION`/`CLOUDFLARED_SHA256`, `HF_HUB_VERSION`, `VASTAI_VERSION`,
`BUILD_JOBS`. A private registry works; pass `--login '-u USER -p TOKEN ghcr.io'`
to `find-offer.sh`.

## Run the benchmark end to end

Cost: about 4 to 5 hours of machine time for three quants and two runtimes,
so roughly $5 to $14 depending on the offer.

```sh
pip install vastai            # and jq
vastai set api-key <KEY>      # key with instance_read, instance_write, user_read, misc

demo/instance/find-offer.sh                    # look at the ranked list
demo/instance/find-offer.sh --create --image ghcr.io/<you>/locus-instance:2026-11-16
#   or --offer <id> to pick a specific row; --max-dph caps the price

vastai show instance <id>                      # wait for "running"
ssh $(vastai ssh-url <id> | sed 's#ssh://##; s#:\([0-9]*\)$# -p \1#')
```

On the machine:

```sh
tmux new -s bench
bench.sh --hw-only                    # 1 second: check CPU slice, RAM, GPU, driver
bench.sh 2>&1 | tee /workspace/bench.log
#   faster first pass: bench.sh --quick --quants UD-IQ4_XS
```

Back on your laptop:

```sh
scp -P <port> -r root@<host>:/workspace/bench/<timestamp> ./bench-results/
vastai destroy instance <id> -y
vastai show instances                 # must be empty
```

Paste `results.md` into `demo/BENCHMARK.md` and fill in the decision.

What `bench.sh` does, per quant (`UD-IQ4_XS`; `UD-Q4_K_XL` only if the slice
has >= 190 GB RAM):

1. `hf download` with Xet high-performance mode, timed.
2. Per runtime, a binary search over server loads for the smallest `-ncmoe`
   that keeps VRAM under 29.5 GB (`--vram-target`), each load timed.
3. Configs: that `-ncmoe` with threads = physical cores of the slice and half
   of that, plus `-ncmoe`+3 at full threads.
4. Per config: prompts of ~60, 16k and 32k tokens, thinking off and low,
   2 repeats, `cache_prompt: false`. Speeds come from llama-server's
   `timings` (`prompt_per_second`, `predicted_per_second`).
5. Quality: each prompt in `prompts/spot-check.jsonl` (with `{{REPORT}}`
   replaced by `prompts/sample-report.txt`) on the fastest config, thinking
   off and low; answers in `quality/<quant>/*.md`.
6. Deletes the quant (disk is 250 GB) unless `--keep-models`.

Outputs in `/workspace/bench/<timestamp>/`: `results.jsonl` (one object per
download, probe, load, request, quality answer), `results.md`,
`hardware.json` / `hardware.txt`, `logs/` (server logs, raw responses).
`bench.sh --summarize DIR` rebuilds `results.md`. If a 32k request runs out
of VRAM, rerun with `--vram-target 28500`. Extra server flags for one runtime:
`IK_EXTRA="-ub 2048 -b 2048" bench.sh ...`.

Memory speed and channel count come from `dmidecode`, which most containers
cannot read; `hardware.json` then says so. The Vast offer page lists them.

## Demo machine: env contract

The image's `CMD` is `/opt/locus/onstart.sh`, so entrypoint (args) launch mode
needs nothing else. In ssh/jupyter launch modes Vast replaces the entrypoint;
put this in the onstart field (the field is capped at 4048 characters, which is
why the script lives in the image):

```sh
nohup /opt/locus/onstart.sh >>/var/log/locus-onstart.log 2>&1 &
```

| Variable | Required | Meaning |
|---|---|---|
| `MODEL_REPO` | yes | e.g. `unsloth/Qwen3.8-Flash-Next-GGUF` |
| `MODEL_FILES` | yes | space-separated repo paths, e.g. all four `UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-0000N-of-00004.gguf`. The model is the `-00001-of-` shard. Include the last shard: it holds the n-gram table |
| `RUNTIME` | yes | `ik` or `mainline` |
| `LLAMA_ARGS` | no | flags from the benchmark, e.g. `-ncmoe 14 -t 32 -c 40960`. Appended last, so they override the defaults. Quotes work; put JSON in single quotes |
| `LLAMA_API_KEY` | yes | bearer key; written to a 0600 file and passed with `--api-key-file` |
| `CF_TUNNEL_TOKEN` | yes | remotely-managed tunnel token; ingress must point at `http://localhost:8080` |
| `DEMO_TTL_SECONDS` | yes | hard lifetime from container start; then the instance destroys itself |
| `CONTAINER_ID`, `CONTAINER_API_KEY` | injected by Vast | used by the self-destruct timer |
| `HF_TOKEN`, `MODELS_DIR`, `STARTUP_TIMEOUT`, `DESTROY_ON_FAILURE` | no | see the header of `onstart.sh` |

Server defaults: `127.0.0.1:8080 -ngl 999 -np 1 --jinja`, plus `--defer-ple`
for ik (and `GGML_CUDA_NO_PINNED=1` from the wrapper) or
`--fit off` for mainline: the same base as `bench.sh`, so a
benchmarked config is reproduced by putting its `-ncmoe`/`-t`/`-c` in
`LLAMA_ARGS`. `/health` needs no key on either runtime; everything else does.

Behaviour: the self-destruct timer starts first and runs in its own session,
so it fires even if the download hangs or the script dies. The deadline is
saved in `/var/lib/locus/deadline` and never extended by a re-run. At the
deadline it stops the server and calls
`vastai destroy instance $CONTAINER_ID -y --api-key $CONTAINER_API_KEY` (the
`-y` matters: without it the CLI aborts at its confirmation prompt and exits
0), with the REST `DELETE` as fallback, retrying every 30 s. The script exits
non-zero if the download fails 3 times, if the server does not answer
`/health` within `STARTUP_TIMEOUT`, or if it fails to come back 5 times in a
row after crashes; it then also stops the tunnel. State for debugging over
ssh: `/var/lib/locus/{status,download.log,server.log,cloudflared.log,self-destruct.log}`.

Thinking control for clients: the chat template turns thinking off only with
`chat_template_kwargs: {"enable_thinking": false}`; effort levels are
`reasoning_effort` `low`, `medium`, `xhigh` (default). There is no `none`
level in the template (it raises an error); mainline also maps the OpenAI
field `reasoning_effort: "none"` to thinking off, ik does not.
