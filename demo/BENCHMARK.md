# Qwen3.8-Flash-Next on one RTX 5090: benchmark

Status: **run on 2026-11-16/17, passed.** Raw output of `bench.sh` is not in
the repo; the tables below are its `results.md`. How to run it:
`demo/instance/README.md`.

## Result

On a DDR4-generation EPYC server slice with one RTX 5090, the 4-bit model
generates at **44–60 tokens/s** and holds that to 32k context. The pass bar was
20 tokens/s at 16k context.

| | ik_llama.cpp | mainline llama.cpp |
|---|---|---|
| Generation at 16k, `UD-IQ4_XS` | 50–52 t/s | 56–60 t/s |
| Prompt reading at 16k, `UD-IQ4_XS` | 511 t/s | 190 t/s (326–335 without `--no-op-offload`) |
| Time to read a 16k-token document | ~31 s | ~84 s (~48 s without the flag) |
| Generation at 16k, `UD-Q4_K_XL` | 43–45 t/s | 46–52 t/s |

- `--no-op-offload` costs mainline about 40% of its prompt-reading speed and
  gains nothing in generation. Do not use it.
- Halving threads (30 to 15) costs ik about 20% generation and 40% prompt
  reading: the CPU side matters, which is the product's point.
- Giving the GPU about 4 GB less (three more expert layers on CPU) costs 5–8%.
- `UD-Q4_K_XL` is 10–15% slower than `UD-IQ4_XS` and showed no quality gain on
  the spot check.

## Decision

| | |
|---|---|
| Runtime (`RUNTIME`) | `ik`: document analysis is the demo's main example and ik reads prompts 1.5–2.7x faster; mainline's generation lead is ~15% |
| Quant (`MODEL_FILES`) | all files under `UD-IQ4_XS/` of `unsloth/Qwen3.8-Flash-Next-GGUF` (93.7 GB) |
| Flags (`LLAMA_ARGS`) | `-ngl 999 -ncmoe 29 -t <physical cores> -c 40000 -np 1 --defer-ple --jinja` |
| Minimum RAM slice for the offer search | 128 GB (not tested below 367 GB; the model file is 94 GB) |
| Expected cold start (download + load) | ~9 min download at ~190 MB/s, plus load. The 6–9 s loads measured here were with the file already in page cache; a first load reads from disk and was not measured |
| Instance destroyed, `vastai show instances` empty | yes (2026-11-17) |

Not measured: any DDR5 or AVX-512 host, RAM slices near 128 GB, more than one
user at a time, and `-ncmoe` on a host with fewer cores.

## Pass bar

**>= 20 tokens/s generation at 16k context on a 4-bit-class quant**
(`UD-IQ4_XS` or `UD-Q4_K_XL`), single user, thinking off. Passed by every
configuration tested; the slowest was 40.3 t/s.

## Setup

| | |
|---|---|
| Date | 2026-11-16 to 2026-11-17 |
| Vast offer / instance | offer 59874461 / instance 60968022 (United Kingdom) |
| Price | $1.27/h |
| Image | `nvidia/cuda:13.0.3-devel-ubuntu24.04` + `setup-on-box.sh` (the instance image has not been built yet) |
| ik_llama.cpp | `a6383da414f7` |
| llama.cpp (mainline) | `ad5cbfa911b9` |
| Total cost of the run | $11.21 of Vast credit, including a first rental destroyed for a host-side ssh fault and a final chat-proxy test |

## Hardware

| | |
|---|---|
| CPU | AMD EPYC 7C13 64-Core Processor (1 socket(s), 128 host threads, 2 threads/core) |
| CPU slice | 61 CPUs (quota), 30 physical cores used for -t |
| ISA | AVX-512: no, ik build: v3 |
| RAM | slice 367 GB, host 540 GB |
| Memory | not readable in this container (dmidecode needs DMI access) |
| GPU | NVIDIA GeForce RTX 5090, 32607 MiB, PCIe gen 4 x16 |
| Driver / CUDA | 580.82.09 / 13.0 |
| Runtimes | ik a6383da414f7, mainline ad5cbfa911b9 |
| Vast | instance 60968022 |

## Download and load

| quant | download GB | download s | MB/s | first load s (ik) | first load s (mainline) |
|---|---|---|---|---|---|
| UD-IQ4_XS | 93.7 | 497.0 (quick pass; reused in the full run) | 188 | 6.1 | 8.3 |
| UD-Q4_K_XL | 111.3 | 624.0 | 178 | 6.3 | 9.1 |

## Throughput

Tokens/s, mean of 2 runs. Prompt lengths: short (~30-60 tokens), 16k, 32k.

| quant | runtime | -ncmoe | threads | VRAM MiB | context | thinking | prompt tok | prefill t/s | gen tok | gen t/s |
|---|---|---|---|---|---|---|---|---|---|---|
| UD-IQ4_XS | ik | 29 | 30 | 28457 | short | off | 29 | 165.2 | 51 | 54.7 |
| UD-IQ4_XS | ik | 29 | 30 | 28457 | short | low | 57 | 208 | 310 | 56.7 |
| UD-IQ4_XS | ik | 29 | 30 | 28457 | 16k | off | 16020 | 510.6 | 91 | 49.9 |
| UD-IQ4_XS | ik | 29 | 30 | 28457 | 16k | low | 16048 | 511 | 654 | 51.9 |
| UD-IQ4_XS | ik | 29 | 30 | 28457 | 32k | off | 31868 | 503.8 | 125 | 48.4 |
| UD-IQ4_XS | ik | 29 | 30 | 28457 | 32k | low | 31896 | 501.8 | 1024 | 49.6 |
| UD-IQ4_XS | ik | 29 | 15 | 28457 | short | off | 29 | 115.1 | 51 | 43.3 |
| UD-IQ4_XS | ik | 29 | 15 | 28457 | short | low | 57 | 139.5 | 274 | 44.5 |
| UD-IQ4_XS | ik | 29 | 15 | 28457 | 16k | off | 16020 | 298.6 | 89 | 40.3 |
| UD-IQ4_XS | ik | 29 | 15 | 28457 | 16k | low | 16048 | 298.1 | 1024 | 41.9 |
| UD-IQ4_XS | ik | 29 | 15 | 28457 | 32k | off | 31868 | 293.4 | 111 | 39.7 |
| UD-IQ4_XS | ik | 29 | 15 | 28457 | 32k | low | 31896 | 292.6 | 1024 | 40.5 |
| UD-IQ4_XS | ik | 32 | 30 | 24255 | short | off | 29 | 156.8 | 77 | 49.4 |
| UD-IQ4_XS | ik | 32 | 30 | 24255 | short | low | 57 | 199 | 281 | 51.9 |
| UD-IQ4_XS | ik | 32 | 30 | 24255 | 16k | off | 16020 | 476.7 | 88 | 46.1 |
| UD-IQ4_XS | ik | 32 | 30 | 24255 | 16k | low | 16048 | 476.6 | 790 | 47.8 |
| UD-IQ4_XS | ik | 32 | 30 | 24255 | 32k | off | 31868 | 468.7 | 105 | 45.2 |
| UD-IQ4_XS | ik | 32 | 30 | 24255 | 32k | low | 31896 | 466.9 | 1024 | 46 |
| UD-IQ4_XS | mainline | 30 | 30 | 28147 | short | off | 29 | 94.1 | 55 | 57.6 |
| UD-IQ4_XS | mainline | 30 | 30 | 28147 | short | low | 57 | 98.1 | 331 | 61.6 |
| UD-IQ4_XS | mainline | 30 | 30 | 28147 | 16k | off | 16020 | 191.5 | 114 | 56.1 |
| UD-IQ4_XS | mainline | 30 | 30 | 28147 | 16k | low | 16048 | 189.9 | 1024 | 60 |
| UD-IQ4_XS | mainline | 30 | 30 | 28147 | 32k | off | 31868 | 188.5 | 100 | 55.8 |
| UD-IQ4_XS | mainline | 30 | 30 | 28147 | 32k | low | 31896 | 187.6 | 788 | 59.7 |
| UD-IQ4_XS | mainline | 30 | 15 | 28147 | short | off | 29 | 70.2 | 55 | 48.5 |
| UD-IQ4_XS | mainline | 30 | 15 | 28147 | short | low | 57 | 73.7 | 331 | 51.2 |
| UD-IQ4_XS | mainline | 30 | 15 | 28147 | 16k | off | 16020 | 147.5 | 114 | 46.9 |
| UD-IQ4_XS | mainline | 30 | 15 | 28147 | 16k | low | 16048 | 146.4 | 1024 | 50.3 |
| UD-IQ4_XS | mainline | 30 | 15 | 28147 | 32k | off | 31868 | 145.6 | 100 | 46.9 |
| UD-IQ4_XS | mainline | 30 | 15 | 28147 | 32k | low | 31896 | 144.7 | 788 | 49.8 |
| UD-IQ4_XS | mainline | 33 | 30 | 24147 | short | off | 29 | 88.9 | 60 | 54.5 |
| UD-IQ4_XS | mainline | 33 | 30 | 24147 | short | low | 57 | 94.8 | 313 | 58.2 |
| UD-IQ4_XS | mainline | 33 | 30 | 24147 | 16k | off | 16020 | 175 | 111 | 52.2 |
| UD-IQ4_XS | mainline | 33 | 30 | 24147 | 16k | low | 16048 | 174.3 | 969 | 56.8 |
| UD-IQ4_XS | mainline | 33 | 30 | 24147 | 32k | off | 31868 | 173 | 111 | 53.2 |
| UD-IQ4_XS | mainline | 33 | 30 | 24147 | 32k | low | 31896 | 172.1 | 1024 | 55.7 |
| UD-Q4_K_XL | ik | 34 | 30 | 28653 | short | off | 29 | 160.4 | 59 | 46 |
| UD-Q4_K_XL | ik | 34 | 30 | 28653 | short | low | 57 | 203.2 | 374 | 49.4 |
| UD-Q4_K_XL | ik | 34 | 30 | 28653 | 16k | off | 16020 | 515 | 85 | 44.2 |
| UD-Q4_K_XL | ik | 34 | 30 | 28653 | 16k | low | 16048 | 514.3 | 1024 | 44.8 |
| UD-Q4_K_XL | ik | 34 | 30 | 28653 | 32k | off | 31868 | 507.3 | 108 | 42.4 |
| UD-Q4_K_XL | ik | 34 | 30 | 28653 | 32k | low | 31896 | 505.6 | 1024 | 43.8 |
| UD-Q4_K_XL | ik | 34 | 15 | 28653 | short | off | 29 | 131.7 | 59 | 44.9 |
| UD-Q4_K_XL | ik | 34 | 15 | 28653 | short | low | 57 | 156.4 | 267 | 47.2 |
| UD-Q4_K_XL | ik | 34 | 15 | 28653 | 16k | off | 16020 | 309.2 | 98 | 42.8 |
| UD-Q4_K_XL | ik | 34 | 15 | 28653 | 16k | low | 16048 | 309.1 | 691 | 44 |
| UD-Q4_K_XL | ik | 34 | 15 | 28653 | 32k | off | 31868 | 304.6 | 104 | 40.1 |
| UD-Q4_K_XL | ik | 34 | 15 | 28653 | 32k | low | 31896 | 303.9 | 925 | 43.5 |
| UD-Q4_K_XL | ik | 37 | 30 | 24153 | short | off | 29 | 151.3 | 64 | 44.9 |
| UD-Q4_K_XL | ik | 37 | 30 | 24153 | short | low | 57 | 190.5 | 307 | 47.2 |
| UD-Q4_K_XL | ik | 37 | 30 | 24153 | 16k | off | 16020 | 482.4 | 93 | 43.1 |
| UD-Q4_K_XL | ik | 37 | 30 | 24153 | 16k | low | 16048 | 481.7 | 835 | 45 |
| UD-Q4_K_XL | ik | 37 | 30 | 24153 | 32k | off | 31868 | 474 | 108 | 42 |
| UD-Q4_K_XL | ik | 37 | 30 | 24153 | 32k | low | 31896 | 472.2 | 924 | 43.2 |
| UD-Q4_K_XL | mainline | 34 | 30 | 28183 | short | off | 29 | 95.8 | 59 | 49.6 |
| UD-Q4_K_XL | mainline | 34 | 30 | 28183 | short | low | 57 | 102.8 | 320 | 51.8 |
| UD-Q4_K_XL | mainline | 34 | 30 | 28183 | 16k | off | 16020 | 197.4 | 112 | 48.3 |
| UD-Q4_K_XL | mainline | 34 | 30 | 28183 | 16k | low | 16048 | 196.9 | 780 | 51.8 |
| UD-Q4_K_XL | mainline | 34 | 30 | 28183 | 32k | off | 31868 | 195.1 | 101 | 48.2 |
| UD-Q4_K_XL | mainline | 34 | 30 | 28183 | 32k | low | 31896 | 194.1 | 1024 | 51.4 |
| UD-Q4_K_XL | mainline | 34 | 15 | 28183 | short | off | 29 | 79.1 | 59 | 47.4 |
| UD-Q4_K_XL | mainline | 34 | 15 | 28183 | short | low | 57 | 83.7 | 320 | 50.4 |
| UD-Q4_K_XL | mainline | 34 | 15 | 28183 | 16k | off | 16020 | 149.3 | 112 | 45.8 |
| UD-Q4_K_XL | mainline | 34 | 15 | 28183 | 16k | low | 16048 | 149.2 | 780 | 48.5 |
| UD-Q4_K_XL | mainline | 34 | 15 | 28183 | 32k | off | 31868 | 147.9 | 101 | 45.6 |
| UD-Q4_K_XL | mainline | 34 | 15 | 28183 | 32k | low | 31896 | 147.5 | 1024 | 47.9 |
| UD-Q4_K_XL | mainline | 37 | 30 | 23683 | short | off | 29 | 90.7 | 59 | 47.4 |
| UD-Q4_K_XL | mainline | 37 | 30 | 23683 | short | low | 57 | 97.4 | 276 | 49.2 |
| UD-Q4_K_XL | mainline | 37 | 30 | 23683 | 16k | off | 16020 | 182.6 | 107 | 46.5 |
| UD-Q4_K_XL | mainline | 37 | 30 | 23683 | 16k | low | 16048 | 181.3 | 1024 | 49.3 |
| UD-Q4_K_XL | mainline | 37 | 30 | 23683 | 32k | off | 31868 | 180.5 | 99 | 45.9 |
| UD-Q4_K_XL | mainline | 37 | 30 | 23683 | 32k | low | 31896 | 179.9 | 968 | 48.7 |

### Mainline without `--no-op-offload` (1 run each)

| quant | runtime | -ncmoe | threads | VRAM MiB | context | thinking | prompt tok | prefill t/s | gen tok | gen t/s |
|---|---|---|---|---|---|---|---|---|---|---|
| UD-IQ4_XS | mainline | 30 | 30 | 29149 | short | off | 29 | 88.8 | 55 | 57.2 |
| UD-IQ4_XS | mainline | 30 | 30 | 29149 | short | low | 57 | 99.9 | 331 | 61.1 |
| UD-IQ4_XS | mainline | 30 | 30 | 29149 | 16k | off | 15997 | 334.5 | 104 | 55.4 |
| UD-IQ4_XS | mainline | 30 | 30 | 29149 | 16k | low | 16025 | 325.4 | 813 | 59.9 |
| UD-IQ4_XS | mainline | 30 | 30 | 29149 | 32k | off | 31980 | 318.9 | 99 | 54.1 |
| UD-IQ4_XS | mainline | 30 | 30 | 29149 | 32k | low | 32008 | 311.6 | 985 | 59.3 |

## Best generation speed at 16k

| quant | runtime | -ncmoe | threads | thinking | gen t/s | prefill t/s | pass |
|---|---|---|---|---|---|---|---|
| UD-IQ4_XS | ik | 29 | 30 | low | 51.9 | 511 | yes |
| UD-IQ4_XS | mainline | 30 | 30 | low | 60 | 189.9 | yes |
| UD-Q4_K_XL | ik | 37 | 30 | low | 45 | 481.7 | yes |
| UD-Q4_K_XL | mainline | 34 | 30 | low | 51.8 | 196.9 | yes |

## Quality spot check

Synthetic financial report prompts (`demo/instance/prompts/`), run on ik.
Only the KPI table and the arithmetic check were verified against the report
by hand; the risk summary, board note and general answers were not reviewed.

| quant | KPI table (thinking off) | arithmetic check (off and low) |
|---|---|---|
| UD-IQ4_XS | all figures correct; left some "change" cells as n/a rather than computing them | correct |
| UD-Q4_K_XL | all figures correct; computed the missing changes correctly (-10.8%, -11.4%, -54.2%) | correct |

## End-to-end check against the real model

With the chosen configuration serving, the Worker's manual mode
(`MANUAL_UPSTREAM_URL` through an ssh tunnel) streamed three chats:
content and `reasoning_content` arrive as separate deltas, the thinking switch
(`enable_thinking`) works both ways, and the final chunk carries `timings`
(55–58 t/s generation; the 2,204-token sample report was read at 457 t/s).
The browser page itself was not driven against the real model.

## Strata v0.2.17 on one RTX 3090

Status: **run on 2026-11-21, not yet run as a demo machine.** Raw output is
not in the repo. `RUNTIME=strata` in `onstart.sh` starts it the way it ran
here; the default runtime is still `ik`.

This was a different machine from the 5090 run above, so compare it only with
the ik_llama.cpp / mainline baseline measured on the **same Vast offer** on
2026-11-18 (its write-up is on the `benchmark-rtx3090` branch).

### Result

On one RTX 3090 with a 16-core EPYC 7302P, Strata reads prompts about
**12x faster** than mainline and generates about **3x faster** with its
default drafter. Even with no drafter it generates 2.3x faster.

| UD-IQ4_XS, 15 threads, thinking off | Expert placement | 16k prefill t/s | 16k gen t/s | 32k prefill t/s | 32k gen t/s |
|---|---|---:|---:|---:|---:|
| ik_llama.cpp (baseline) | `-ncmoe 35` | 208.7 | 27.8 | 205.6 | 27.4 |
| mainline llama.cpp (baseline) | `-ncmoe 36` | 240.7 | 31.8 | 229.4 | 31.6 |
| Strata, no drafter | 7,553-expert VRAM cache, rest in RAM | 2,822 | 74.6 | 2,909 | 79.7 |
| Strata, MTP drafter | 7,087-expert cache | 2,831 | 100.1 | 2,923 | 114.8 |
| **Strata default (DFlash2)** | 7,201-expert cache | **2,833** | **108.9** | **2,937** | **112.8** |

- Time to the first token of a 16k-token document: 5.7 s, against roughly 67
  to 77 s implied by the baseline rates. Strata reads the prompt on the GPU in
  32k-token chunks and streams the experts over PCIe; llama.cpp computes the
  offloaded experts on the CPU.
- The 16 GiB VRAM expert cache served 61 to 84% of the routed experts while
  generating. The drafters add another 30 to 45%; DFlash2 accepted 50 to 76%
  of its drafted tokens, MTP 46 to 67%.
- `UD-Q4_K_XL` with the default drafter: 2,774 t/s prefill and 85.6 t/s
  generation at 16k (baseline: ik 225.5 / 31.7, mainline 183.5 / 31.8).
- Sampled rows (temperature 0.7, top_p 0.8, top_k 20, presence penalty 1.5).
  Greedy was not consistently different. Means of two runs; the spread was
  large on these short answers (DFlash2 16k greedy: 93.5 and 119.7 t/s).

### Several users at once

`loadgen.py` from the baseline, `UD-IQ4_XS`, 1/2/4/8 users with two requests
each. Aggregate t/s includes queueing and prefill. Eight users:

| Configuration | Chat t/s | Chat p95 TTFT s | Doc t/s | Doc p95 TTFT s | Shared-doc t/s | Shared-doc p95 TTFT s |
|---|---:|---:|---:|---:|---:|---:|
| **Strata, 1 slot, DFlash2 (default)** | 93.6 | 19.1 | 74.0 | 26.1 | 116.0 | 19.0 |
| Strata, 1 slot, MTP | 89.9 | 23.6 | 74.5 | 30.6 | 103.0 | 25.0 |
| Strata, 4 slots, MTP | 102.8 | 15.3 | 53.7 | 25.4 | 94.6 | 16.4 |
| Strata, 8 slots, MTP | 105.4 | 2.1 | 54.2 | 16.2 | 106.8 | 2.0 |
| *baseline* mainline, 8 slots | 52.5 | 3.0 | 26.6 | 40.9 | 51.6 | 6.7 |
| *baseline* mainline, 8 slots, `-ub 2048` | 52.8 | 3.0 | 36.8 | 19.95 | 52.8 | 4.3 |

- One request at a time already gives 1.8x the baseline's best eight-user
  chat throughput and 2 to 2.8x on documents. Waiting grows with the queue:
  p95 time to first token is 19 to 26 s at eight users.
- Eight slots bring the chat wait down to 2 s, close to mainline, but make
  documents slower (about 54 t/s against 74 with one slot): with slots,
  reading a 2.2k-token document took about 2.2 s instead of 1.2 s.
- `--batch-mtp` (each slot drafting) did not help on this card.
- **Slot count:** a follow-up on a second machine (below) measured 1, 2 and
  3 slots. One slot with DFlash2 stays the default.

### Slot count and the GSQ-RCO IQ3_S quant (second machine)

Run on 2026-11-21 on a different Vast machine: RTX 3090 with an EPYC 7443
(15 CPU workers), so compare only within this section. Same `loadgen.py`,
DFlash2 drafter, 40k context, thinking off, `UD-IQ4_XS` re-measured on the
same box alongside the new quant.

The new quant is `IQ3_S` from
[`ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF).
It assigns a quant type per tensor (target 3.5 bpw over the file) and is
83.6 GB in two shards, against 93.7 GB for `UD-IQ4_XS`. Strata runs it
unmodified: `strata launch --model-path <dir> --model iq3_s --context 40960
--vision off --parallel 1 --drafting dflash2`.

| | UD-IQ4_XS | GSQ-RCO IQ3_S |
|---|---:|---:|
| VRAM expert cache, 1 slot | 7,188 experts (16.2 GiB) | **8,771 experts (16.6 GiB)** |
| VRAM expert cache, 3 slots | 6,185 experts (13.9 GiB) | 7,572 experts (14.4 GiB) |
| One user, 16k prefill t/s | 2,284 | 2,311 |
| One user, 16k gen t/s | 86.7 | **95.9** |

Eight users, aggregate t/s (p95 time to first token in brackets):

| Configuration | Chat | Doc | Shared-doc |
|---|---:|---:|---:|
| UD-IQ4_XS, 1 slot | 82.6 (23.7 s) | 64.5 (33.8 s) | 98.6 (23.2 s) |
| UD-IQ4_XS, 2 slots | 77.2 (26.4 s) | 42.4 (53.0 s) | 63.6 (31.5 s) |
| UD-IQ4_XS, 3 slots | 89.4 (18.8 s) | 45.3 (48.9 s) | 82.7 (21.0 s) |
| **IQ3_S, 1 slot** | 92.3 (19.8 s) | **74.4 (26.8 s)** | **110.7 (22.4 s)** |
| IQ3_S, 3 slots | **103.5 (12.5 s)** | 54.9 (29.6 s) | not run |

The 2-slot row and the 3-slot shared-doc cell come from the earlier slot run
on the same box, a few hours before; the rest were measured back to back.

Speed each user sees while their answer is being written, eight users:

| Configuration | Chat t/s per user | Doc t/s per user |
|---|---:|---:|
| UD-IQ4_XS, 1 slot | 89 | 104 |
| UD-IQ4_XS, 3 slots | 34 | 24 |
| IQ3_S, 1 slot | 99 | 124 |
| IQ3_S, 3 slots | 38 | 28 |

- With one slot, requests take turns: each answer streams at full speed, but
  the others wait (mean time to first token 8 s for chat, 13 s for documents
  at eight users with IQ3_S). With three slots, three answers stream at once
  at about a third of the speed each.
- 2 slots was worse than both 1 and 3. 3 slots wins only on chat; documents
  lose 25 to 30%. One slot with DFlash2 stays the default.
- IQ3_S is 10 to 21% faster than UD-IQ4_XS everywhere except prefill: the
  smaller experts fit 22% more of them in the VRAM cache.
- Quality: 15 short reasoning, coding and factual prompts with thinking on;
  both quants answered 15/15 with no loops or garbled output. This is a
  sanity check, not an eval; it cannot show small quality differences.
- 840 requests over the whole run (all configurations), none failed. Peak
  VRAM 23.6 GiB of 24.
- Instance 61823687 at $0.648/h, destroyed, `vastai show instances` empty.

### Caveats

- **No `ignore_eos`:** Strata ignores it, so multi-user answers ended
  naturally at 176 to 246 tokens (means), not the baseline's fixed 256.
  Shorter answers slightly lower the aggregate t/s and shorten the queue.
- **Model revision:** Strata downloads Unsloth revision `38bb39e` and checks
  each file's SHA-256 (UD-IQ4_XS is three shards there, 93.7 GB). The
  baseline used `f5d175de2cf7` (four shards). Same quant name and total size;
  tensor-level identity was not checked.
- **Eight slots crashed once per config:** the first document request after
  the chat batches ended the engine with `cuBLAS status 14` after "no VRAM
  for a new window graph" warnings. Strata's server restarted the engine by
  itself in about 40 s; one request failed and the next waited 46 s. 538 of
  540 requests succeeded. Strata itself warns that a 24 GB card holds 3
  requests at once.
- **memlock:** the container's limit was 8 MiB and could not be raised, even
  as root (Strata's Docker docs ask for `--ulimit memlock=-1`, which Vast does
  not offer). Strata still ran; only its 26.8 GiB PLE table stayed unlocked,
  which Strata says costs up to 6% generation speed.
- Strata's KV cache is int8 (llama.cpp's default is f16), it ignores
  `cache_prompt: false` (every timed request started with a unique line, and
  all showed `cache_n` 0), and the single-user answers were 57 to 121 tokens.
- Not measured: an RTX 5090, thinking on, `UD-Q4_K_XL` with several users,
  and host or GPU telemetry.

### Setup

| | |
|---|---|
| Date | 2026-11-21, 13:55 to 15:35 UTC |
| Vast offer / instance | offer 60431240 (the baseline's) / instance 61809268, destroyed, `vastai show instances` empty |
| Price / cost | $0.656/h / $3.89 of Vast credit |
| Hardware | RTX 3090 24 GB (PCIe 4.0 x16), AMD EPYC 7302P 16 cores / 32 threads, all 32 threads in the affinity mask, 259 GB container RAM; driver 615.78.08, CUDA 13.4 |
| Image | `nvidia/cuda:13.0.3-devel-ubuntu24.04` + Strata's `install.sh` (checksum and signature passed) |
| Strata | release v0.2.17 (commit `12d491da4a69`), Terminal and engine build 0.1.63 (`linux-x86_64-cuda-cuda13`) |
| Launch | `strata launch --family unsloth --model UD-IQ4_XS --context 40960 --vision off --yes --no-tui` (the benchmark used `--no-api-key`; the demo passes the key) |
| Strata's choices | all experts in RAM, VRAM expert cache `auto`, KV `int8`, 15 CPU workers, DFlash2 drafter (`--spec 6`), one request at a time |
| First start | 827 s including the engine and the 93.7 GB download (100 to 260 MB/s); restarts with the files in page cache about 45 s |

### Quality and API

- Spot check (five prompts from `demo/instance/prompts/`, thinking off): both
  quants summed the segments to EUR 184.6 million correctly and extracted the
  KPI table; `UD-IQ4_XS` left some derivable changes as n/a, as ik did on the
  5090. No reasoning text leaked into answers.
- API, as the Worker uses it: thinking arrives as `reasoning_content`
  deltas, `enable_thinking: false` turns it off, and the last chunk carries
  llama.cpp-style `timings`. `/health` answers without the key. Thinking is
  on by default when the request does not say; the Worker always says.

## Round 3: L4, 3090 rerun, several users at once, Apertus (2026-11-22/23)

Status: **run on Vast, not as demo machines.** Raw output is not in the repo.
Nothing here changes the demo's runtime or flags: one Strata slot with DFlash2
on a 24 GB card stays the default. Each box is a different host, so compare
only within a table.

The multi-user tables use two speeds:

- **Generation speed per user:** how fast one answer streams once its first
  word has appeared (median over requests).
- **Total output, prompt reading included:** all generated tokens divided by
  the wall time of the whole run, including waiting and prompt reading.

With one user the total is lower than the per-user speed: the per-user
clock starts at the first word, the total clock starts when the request is
sent, so prompt reading only counts against the total.

### Strata IQ3_S on one NVIDIA L4

GSQ-RCO `IQ3_S`, Strata with DFlash2, `--gpu 0` (Strata ignores
`CUDA_VISIBLE_DEVICES`).

| Host | Power limit | 16k prefill t/s | Gen t/s, one user | 16k time to first token |
|---|---:|---:|---:|---:|
| Threadripper 3945WX, 3×L4 box | **40 W** (host cap) | ~610 | ~15 | 26 s |
| Xeon Platinum 8268 | 72 W (stock) | ~1,400 | 35–38 | 11–12 s |
| *RTX 3090, EPYC 7443 (above)* | 350 W | 2,311 | 96 | 7 s |

- The first L4 was slow mainly because the host capped it at 40 W; renters
  can't raise it. At 40 W the SM clock sat near its 210 MHz floor while
  streaming memory. **Check `nvidia-smi -q -d POWER` before trusting any Vast
  benchmark.**
- At 72 W the power cap was still active 90–97% of the time under Strata
  (SM clock 1.2–1.7 GHz, against 2.04 GHz maximum).
- Strata v0.2.19's sm_89 speed table made no measurable difference.
- Per decode window (about 2 rows): GPU wait 22.0 ms (3090: 12.3), CPU
  experts 23.8 ms (6.2), CPU/GPU sync 9.0 ms (1.9). The GPU part is only
  1.8x slower; much of the remaining gap is the slower host CPU.
- **In progress:** the same run on a fast host (Xeon Gold 6448Y, DDR5, AMX)
  to separate the GPU and host shares.

Several users at once, 72 W L4, `--parallel` = number of users, 40k context:

| Users | Chat: total output, prompt reading included | Chat: generation speed per user | Doc: total output | Doc: generation speed per user | Doc p95 time to first token |
|---:|---:|---:|---:|---:|---:|
| 1 | 33 | 37 | 29 | 43 | 2.6 s |
| 2 | 26 | 17 | 16 | 17 | 21 s |
| 4 | 28 | 10 | 13 | 6 | 42 s |

One slot that queues requests gave 34–36 t/s total for 1–4 chat users, so
parallel slots don't pay off on this card.

### Strata IQ3_S on one RTX 3090, rerun and several users at once

**Rerun** on an EPYC 7502 slice (350 W): 10–20% faster than the EPYC 7443
box above. 16k: 2,800–2,860 t/s prefill, 104–118 t/s generation; 32k:
2,880–2,920 / 109–116. 15/15 on the quality prompts.

**Truly concurrent users** (`--parallel N` for N users) on an EPYC 7713 with
the card capped at 280 W:

| Users | Chat: total output, prompt reading included | Chat: generation speed per user | Doc: total output | Doc: generation speed per user |
|---:|---:|---:|---:|---:|
| 1 | 93 | 103 | 73 | 114 |
| 2 | 76 | 43 | 60 | 44 |
| 4 | 84 | 26 | 56 | 22 |
| 8 | 91 | 14 | 55 | 8 |

- Total output stays at 75–95 t/s whatever the slot count: parallel slots
  split the same throughput between users.
- **Don't serve with `--parallel` 4 or more on a 24 GB card.** Document
  requests right after chat crashed the engine (`cublasGemmEx` status 14,
  about 1 MiB VRAM free): 4 of 8 requests failed at 4 slots, 8 of 16 at 8
  slots. The doc rows above are from a freshly started engine.

### Apertus 1.5 70B NVFP4 on 3×L4

`onprem-ai/Apertus-v1.5-70B-NVFP4` with the swiss-ai vLLM image. The
weights alone are 46.9 GiB, so it needs three L4s: pipeline parallel 3 (64
heads rule out TP 3), fp8 KV, `--language-model-only`, layer split
`23,30,27`, `NCCL_P2P_DISABLE=1`; the KV pool held 48k tokens.

- Generation 3.9 / 3.6 / 3.3 t/s at short / 16k / 32k; prompt reading about
  225 t/s (16k time to first token 71 s).
- 8 chat users: 20 t/s total, 2.6 t/s per user.
- Quality 13/15. Works, but too slow for interactive use on L4s. These L4s
  were probably on the same 40 W-capped host as above.

### Apertus 1.5 8B FP8 on an RTX 3090 and an RTX PRO 6000

`onprem-ai/Apertus-v1.5-8B-FP8` with vLLM, all of it in VRAM. The 3090
(sm_86) has no FP8 maths, so vLLM falls back to weight-only FP8 (Marlin);
the PRO 6000 Blackwell runs native FP8.

| | RTX 3090 (EPYC 7502) | RTX PRO 6000 Blackwell 96 GB (Xeon 6960P, PCIe 5) |
|---|---:|---:|
| Gen t/s, one user, short / 16k / 32k | 94 / 74 / 63 | 139 / 120 / 105 |
| 16k time to first token, uncached | 4.5 s | 0.7 s |
| KV cache room | – | 602k tokens |
| Quality prompts | 13/15 on reading (11/15 by the grader) | 14/15 on reading |

Chat, total output with prompt reading included (generation speed per user
in brackets):

| Users | RTX 3090 | RTX PRO 6000 |
|---:|---:|---:|
| 1 | 92 (92) | 134 (136) |
| 2 | 181 (91) | 267 (136) |
| 4 | 355 (90) | 531 (137) |
| 8 | 681 (87) | 1,032 (134) |
| 16 | – | 1,942 (129) |
| 32 | – | 3,619 (123) |

- A dense 8B model in VRAM scales almost linearly with users, unlike the
  hybrid MoE runs above. Documents (2.2k tokens each) on the PRO 6000:
  848 t/s total at 8 users, 2,091 at 32 (80 t/s per user, p95 time to first
  token 1.0 s).
- One 3090 answer leaked a `<|inner_suffix|>` token, likely a chat template
  or reasoning-parser issue.
- The PRO 6000's power limit was its stock 600 W.
