# Qwen3.8-Flash-Next on one GPU

**RTX 5090 benchmark, 2026-11-16/17. Passed.** Raw output of `bench.sh` is not in
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

## RTX 3090 on a full-CPU EPYC 7302P offer

Run on 2026-11-18. One RTX 3090 (24,576 MiB, PCIe 4.0 x16) on Vast offer
60431240, instance 61259997. The listing allocated the entire GPU fraction
and all 32 host threads to this rental. On the box, all 32 threads were in the
CPU affinity mask, the CPU-time quota was 30.72 logical CPUs, and the
container RAM limit was 259 GB. The host averaged 99.7% CPU idle before
downloads. During one eight-second sample of 32k prefill, the host used about
14.27 logical CPU-equivalents and the benchmark cgroup accounted for 14.24.
A second eight-second sample during concurrency measured 13.91 on the host
and 13.88 in the benchmark cgroup. DIMM population and memory speed were unavailable inside the container.

Both runtimes used the same revisions as the 5090 run, ik `a6383da414f7`
and mainline `ad5cbfa911b9`. The GGUF shards were from
`unsloth/Qwen3.8-Flash-Next-GGUF` revision
`f5d175de2cf7f720d45d6064019a81fcf056e986`. The 93.7 GB
`UD-IQ4_XS` download took 361 s and the 111.3 GB `UD-Q4_K_XL` download took
427 s. The benchmark used a 21,476 MiB loaded-VRAM target and tested
15 and 7 threads.

### Single-user throughput

All 144 throughput requests completed. The table uses the smallest measured
`-ncmoe` that fit the VRAM target for each quant and runtime. Rates are means
of two runs with 15 threads and thinking off. All four 16k configurations
passed the 20 tokens/s generation bar.

| Quant | Runtime | CPU expert layers | Loaded VRAM (MiB) | 16k prefill t/s | 16k generation t/s | 32k prefill t/s | 32k generation t/s |
|---|---|---:|---:|---:|---:|---:|---:|
| UD-IQ4_XS | ik | 35 | 20,361 | 208.7 | 27.8 | 205.6 | 27.4 |
| UD-IQ4_XS | mainline | 36 | 20,895 | 240.7 | 31.8 | 229.4 | 31.6 |
| UD-Q4_K_XL | ik | 39 | 20,887 | 225.5 | 31.7 | 222.1 | 30.9 |
| UD-Q4_K_XL | mainline | 40 | 20,531 | 183.5 | 31.8 | 173.7 | 31.1 |

On `UD-IQ4_XS` at 16k, reducing `-t` from 15 to 7 brought generation to
20.2 t/s on ik and 22.2 t/s on mainline. Moving another three expert layers to
the CPU at 15 threads freed about 3 GiB on ik and 3.6 GiB on mainline.
Generation remained at 26.7 and 30.6 t/s respectively.

Both quants extracted the checked KPI figures and correctly summed segment
revenue to EUR 184.6 million in the thinking-off spot checks. The larger quant
also included order intake. Both marked several unstated changes as n/a.

### Comparison with the 5090 serving run

The table compares `UD-IQ4_XS` at 16k with thinking off. The mainline 5090
entry comes from the corrected flag run above, which used one repeat. The
other entries use two. The 3090 was tested on the EPYC 7302P described above,
and the 5090 on an EPYC 7C13 slice. CPU, available memory, GPU and CPU expert
layer count all differ across the two systems.

| Serving configuration | Threads | CPU expert layers | Prefill t/s | Generation t/s |
|---|---:|---:|---:|---:|
| RTX 3090, ik | 15 | 35 | 208.7 | 27.8 |
| RTX 5090, ik | 15 | 29 | 298.6 | 40.3 |
| RTX 5090, ik | 30 | 29 | 510.6 | 49.9 |
| RTX 3090, mainline | 15 | 36 | 240.7 | 31.8 |
| RTX 5090, mainline | 30 | 30 | 334.5 | 55.4 |

### Multi-user serving

The concurrency suite used `UD-IQ4_XS`, 15 threads, and up to 256 output
tokens per response with EOS ignored. Each of 1, 2, 4, and 8 users sent two
requests in a closed loop. The workloads were short chat, a document with a
different prefix per request, and a shared document with a reusable prefix.
Aggregate throughput includes queue and prefill time. TTFT is time to first
token. Each p95 describes a batch of at most 16 requests.

Ten of the 13 server configurations completed all workloads without request
failures. There were 1,080 attempted requests and 942 successes across the 12
configurations that started. The table shows batches of eight users with zero
failures. A dash marks a batch without a complete result.

| Configuration | Chat t/s | Chat p95 TTFT s | Doc t/s | Doc p95 TTFT s | Shared-doc t/s | Shared-doc p95 TTFT s |
|---|---:|---:|---:|---:|---:|---:|
| ik-1slot | 30.6 | 59.2 | 18.0 | 106.0 | 18.7 | 102.0 |
| ik-1slot-mtp | 31.9 | 57.5 | 19.2 | 101.0 | 21.8 | 84.9 |
| ik-8slots | 40.3 | 8.0 | 16.2 | 85.3 | 29.5 | 29.1 |
| ik-8slots-ub2048 | 40.4 | 8.1 | — | — | — | — |
| ik-8slots-nocram | — | — | — | — | — | — |
| ik-8slots-mtp | — | — | — | — | — | — |
| mainline-1slot | 33.9 | 53.2 | 18.7 | 102.8 | 28.7 | 65.6 |
| mainline-1slot-mtp | 34.1 | 52.8 | 20.0 | 97.0 | 30.3 | 62.6 |
| mainline-8slots | 52.5 | 3.0 | 26.6 | 40.9 | 51.6 | 6.7 |
| mainline-8slots-kvu | 52.1 | 3.2 | 26.5 | 40.5 | 35.7 | 28.2 |
| mainline-8slots-ub2048 | 52.8 | 3.0 | 36.8 | 19.95 | 52.8 | 4.3 |
| mainline-8slots-nocram | 53.0 | 2.9 | 25.7 | 45.1 | 38.1 | 25.0 |
| mainline-8slots-mtp | 39.9 | 3.6 | 21.7 | 48.4 | 37.3 | 7.6 |

These are the scaling results for the default mainline eight-slot configuration.

| Users | Chat aggregate t/s | Chat mean decode t/s | Chat p95 TTFT s | Doc aggregate t/s | Doc p95 TTFT s | Shared-doc aggregate t/s | Shared-doc p95 TTFT s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 33.1 | 36.0 | 0.7 | 18.3 | 7.1 | 21.2 | 7.3 |
| 2 | 41.3 | 22.4 | 1.4 | 15.8 | 13.0 | 29.6 | 6.4 |
| 4 | 48.2 | 12.9 | 2.0 | 17.0 | 25.8 | 35.9 | 11.2 |
| 8 | 52.5 | 6.9 | 3.0 | 26.6 | 40.9 | 51.6 | 6.7 |

- With mainline at eight slots, increasing the microbatch to 2048 raised
  eight-user uncached document throughput from 26.6 to 36.8 t/s and reduced
  p95 TTFT from 40.9 to 19.95 s. Shared-document p95 fell from 6.7 to 4.3 s.
  Eight-user chat stayed near 53 aggregate t/s with about 7 t/s of decode
  speed per active request.
- Two ik variants exited with a CUDA illegal memory access. The larger
  microbatch crashed during the four-user document batch, and disabling the
  RAM cache crashed during the four-user chat batch. The 138 failed requests
  include subsequent requests sent after those exits. The pinned ik build
  also rejects MTP startup with parallel slots.
- Mainline MTP with eight slots ran at `-ncmoe 40` after CUDA allocation failed
  at 36 and 38. The tested MTP configuration delivered 39.9 aggregate t/s at
  eight chat users, compared with 52.5 t/s at `-ncmoe 36` with MTP off.
  Both the speculative decoding setting and expert placement differ.

The historical 5090 comparison covers single-user serving.

### Cost and cleanup

The replacement took about 7 hours 31 minutes from rental to destruction and
used $7.76 of Vast credit. Total spend across both attempts was $7.95.
The first rental, 61256042, ended before model downloads after a script-mode
failure in the resume path. The executable mode is fixed. Vast confirmed
that both rentals were destroyed and the temporary SSH keys were removed.
