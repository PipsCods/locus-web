# Qwen3.8-Flash-Next on one RTX 5090: benchmark

Status: **not run yet**. Fill from `bench.sh` output (`results.md` has these
tables ready to paste). How to run it: `demo/instance/README.md`.

## Pass bar

**>= 20 tokens/s generation at 16k context on a 4-bit-class quant**
(`UD-IQ4_XS` or `UD-Q4_K_XL`), single user, thinking off. If no 4-bit config
passes, the fallback is `UD-Q3_K_XL`, decided together.

## Setup

| | |
|---|---|
| Date | |
| Vast offer / instance | |
| Price | $/h |
| Image | `locus-instance:<tag>` |
| ik_llama.cpp | commit |
| llama.cpp (mainline) | commit |
| Total cost of the run | $ |

## Hardware

| | |
|---|---|
| CPU | |
| CPU slice | CPUs, physical cores used for `-t` |
| ISA / ik build | |
| RAM | slice GB, host GB |
| Memory | type, channels, speed |
| GPU | |
| Driver / CUDA | |

## Download and load

Sizes the Phase 3 wait (the visitor gets an email when the machine is ready).

| quant | download GB | download s | MB/s | first load s (ik) | first load s (mainline) |
|---|---|---|---|---|---|
| UD-IQ4_XS | | | | | |
| UD-Q4_K_XL | | | | | |
| UD-Q2_K_XL | | | | | |

## Throughput

Tokens/s, mean over repeats. Prompt lengths: short (~60 tokens), 16k, 32k.

| quant | runtime | -ncmoe | threads | VRAM MiB | context | thinking | prompt tok | prefill t/s | gen tok | gen t/s |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

## Best generation speed at 16k

| quant | runtime | -ncmoe | threads | thinking | gen t/s | prefill t/s | pass |
|---|---|---|---|---|---|---|---|
| UD-IQ4_XS | ik | | | | | | |
| UD-IQ4_XS | mainline | | | | | | |
| UD-Q4_K_XL | ik | | | | | | |
| UD-Q4_K_XL | mainline | | | | | | |
| UD-Q2_K_XL | ik | | | | | | n/a |
| UD-Q2_K_XL | mainline | | | | | | n/a |

## Quality spot check

Synthetic financial report prompts (`demo/instance/prompts/`), answers in
`quality/<quant>/`. One line per quant: correct figures, table well formed,
arithmetic check right, anything wrong.

| quant | thinking off | thinking low |
|---|---|---|
| UD-IQ4_XS | | |
| UD-Q4_K_XL | | |
| UD-Q2_K_XL | | |

## Decision

| | |
|---|---|
| Runtime (`RUNTIME`) | |
| Quant (`MODEL_FILES`) | |
| Flags (`LLAMA_ARGS`) | |
| Minimum RAM slice for the offer search | GB |
| Expected cold start (download + load) | min |
| Instance destroyed, `vastai show instances` empty | yes / no |
