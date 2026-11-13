// Turns one server configuration + one graphics card into an estimate: the largest model that
// fits, how fast it writes, how many people it serves at once, and what it costs next to a
// GPU-only server. Pure functions, no page code: see check-data.js for the numbers it uses.
//
// How the speed estimate works
// ----------------------------
// For every word, the processor reads the few "specialist" blocks that word needs out of
// memory; the card does the rest. So the time per word is
//
//     time on the card  +  (memory read per word) / (how fast this server can feed memory to the model)
//
// The second term starts from what the memory gives in theory (channels x module speed) and
// is cut down to what is reached in practice. The cut-down factors below were set so the
// formula lands near every published measurement of this technique we could find:
//
//     machine and model                                             measured    formula
//     2 x Xeon Gold 6454S, DDR5-4800, 24 GB card: 671B model        12.2-16.8   13.5   tokens/s
//       the same with one processor                                  8.7         9.7
//     the same machine, 1T model (one / two processors)             10 / 14      9.2 / 13
//     2 x Xeon Platinum 8488C, 48 GB card: 229B model               21.8        22.7
//     2 x EPYC 9355, 32 GB card: 229B model                         32.1        32.5
//       the same: 80B model                                         75.9        83.5
//       the same, measured independently: 671B model                22          20.7
//     1 x EPYC 7402, DDR4-3200, 24 GB card: 671B model              about 5      5.5
//
// For DDR5 machines that is within about 10 %. For DDR4 machines there are only a handful of
// hobbyist measurements and none at all for Xeon Scalable 1st to 3rd generation, so those are
// extrapolated from memory speed, use more cautious factors, and are shown with a wider range.

import { MODELS, GPUS, CONFIGS, PLATFORMS, FULL_GPU } from "./check-data.js";

const GB_PER_CHANNEL = (mts) => (mts * 8) / 1000;   // one memory channel, GB per second, in theory
const REACHED = 0.45;                                // share of that theory one processor reaches in practice
const SOCKET_CAP = 215;                              // GB/s: beyond this, more channels stop helping one processor
const SECOND_SOCKET = 1.5;                           // two processors do not double it: the memory sits on two sides
const KERNEL = { amx: 1.0, bf16: 1.0, avx512: 0.85, avx2: 0.8 };        // older instruction sets work, slower
const PER_CORE = { amx: 12, bf16: 12, avx512: 7, avx2: 5 };             // GB/s one core can work through: very few cores cap the speed
const SPREAD = { amx: 0.15, bf16: 0.15, avx512: 0.25, avx2: 0.25 };     // how uncertain the estimate is, as +/- share
const READABLE = 5;                                  // tokens/s below which live conversation feels slow
const COMFORTABLE = 6;                               // tokens/s each person should still get when several ask at once (about reading pace)
const WORDS = 0.75;                                  // words per token, roughly

export const byId = (list, id) => list.find((x) => x.id === id);

// GB per second this server can actually feed to the model
export function memoryRate(config) {
  const p = byId(PLATFORMS, config.platform);
  const filled = config.channels ?? p.channels; // channels with a module in them, per processor
  const one = Math.min(filled * GB_PER_CHANNEL(config.mts ?? p.mts) * REACHED, SOCKET_CAP);
  return Math.min(one * (config.sockets === 2 ? SECOND_SOCKET : 1) * KERNEL[p.isa], config.sockets * config.cores * PER_CORE[p.isa]);
}

// tokens per second for one person, with this model on this server and card
export function speed(model, config, gpu) {
  const p = byId(PLATFORMS, config.platform);
  // A card with memory to spare keeps the most-used specialists itself, so the processor reads less.
  // Measured: a tenth of them on the card saves roughly 10-25 % of the reading; the gain flattens after that.
  const spare = Math.max(0, gpu.vram - model.vram);
  const onCard = Math.min(0.35, 0.8 * (spare / model.expertsGB));
  const seconds = (model.cardMs * gpu.slow) / 1000 + (model.readGB * (1 - onCard)) / memoryRate(config);
  return { tokS: 1 / seconds, spread: SPREAD[p.isa] };
}

// Several people at once: the total goes up, but far from in step. Published figures range from 1.2x
// (two requests, measured independently) to 2.3x (four requests, the project's own figure); an improved
// engine in the same independent study levels off at 1.6x, and nothing is published beyond four on a
// single card. So: +25 % per extra person, and no gain past 1.6x.
const together = (n, gpu) => 1 + Math.min(0.6, 0.25 * (n - 1)) * gpu.batch;

export function people(tokS, gpu) {
  let n = 1;
  for (let k = 2; k <= 8; k++) if ((tokS * together(k, gpu)) / k >= COMFORTABLE) n = k;
  return { n, each: (tokS * together(n, gpu)) / n };
}

const fits = (model, config, gpu) => config.ram >= model.ram && gpu.vram >= model.vram && model.isa.includes(byId(PLATFORMS, config.platform).isa);

export function estimate(configId, gpuId) {
  const config = byId(CONFIGS, configId), gpu = byId(GPUS, gpuId);
  if (!config || !gpu) return null;
  const platform = byId(PLATFORMS, config.platform);

  // MODELS is ordered largest first. Take the largest one that fits and still writes at a usable pace;
  // if none does, the fastest of those that fit.
  const able = MODELS.filter((m) => fits(m, config, gpu)).map((m) => ({ model: m, ...speed(m, config, gpu) }));
  if (!able.length) return { config, gpu, platform, model: null };
  const pick = able.find((a) => a.tokS >= READABLE) ?? able.reduce((a, b) => (b.tokS > a.tokS ? b : a));
  const { model, tokS, spread } = pick;
  const crowd = people(tokS, gpu);
  // if the pick is on the slow side, name the smaller model that would be clearly faster on the same machine
  const quick = tokS < 10 ? able.slice(able.indexOf(pick) + 1).find((a) => a.tokS >= tokS * 1.5) : null;

  // the next model up, and what stands in its way
  const bigger = MODELS.slice(0, MODELS.indexOf(model)).reverse().find((m) => m.isa.includes(platform.isa));
  let step = null;
  if (bigger) {
    const needRam = config.ram < bigger.ram, needCard = gpu.vram < bigger.vram;
    const slow = !needRam && !needCard; // it fits, it is just too slow on this machine to be the pick
    step = { model: bigger, needRam: needRam ? bigger.ram : 0, needCard: needCard ? bigger.vram : 0, slow, tokS: slow ? speed(bigger, config, gpu).tokS : 0 };
  }

  return {
    config, gpu, platform, model,
    tokS: [tokS * (1 - spread), tokS * (1 + spread)],
    words: [tokS * (1 - spread) * WORDS, tokS * (1 + spread) * WORDS],
    people: crowd.n,
    eachWords: crowd.each * (1 - spread) * WORDS,
    slow: tokS < READABLE,
    add: gpu.price,
    // a model small enough to sit entirely on the chosen card needs no comparison: there is no "room of cards" to avoid
    full: model.fullVram <= gpu.vram ? null : FULL_GPU.find((f) => model.fullVram <= f.vram) ?? FULL_GPU[FULL_GPU.length - 1],
    step,
    faster: quick ? { model: quick.model, tokS: quick.tokS } : null,
  };
}
