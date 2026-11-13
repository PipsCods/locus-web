// Everything "Check your server" offers, and every number its estimate is built from.
// All of it is a snapshot from November 2026. Prices and the model list move fast: review this
// file before relying on it again.
//
// Where the choices come from (market research, November 2026)
// -------------------------------------------------------------
// • What companies own. Dell said in 2025, and again in September 2026, that most of its
//   installed base (over 70 % in 2025) still runs on its 14th generation or older: that is
//   the Xeon Scalable 1st/2nd generation and the Xeon E5 before it. Refresh cycles run 4 to
//   6 years. AMD held about a quarter of server shipments in 2023 and about a third in 2026,
//   so servers bought 2018-2023 are mostly Intel. The list below is therefore weighted
//   towards older Intel machines, and starts on the most common one.
// • Memory. Sizes follow from filling every memory channel, which is how these servers are
//   normally ordered: 6-channel machines come as 192 / 384 / 768 GB, 8-channel ones as
//   256 / 512 / 1024 GB, 12-channel ones as 384 / 768 / 1536 GB. A few half-filled, small
//   set-ups are included because general-purpose hosts are often bought that way.
// • Processor names are common models of each generation (no public sales ranking exists),
//   chosen to cover low, middle and high core counts.
// • Cards. 2026 prices are two to three times those of 2025. The three offered cover: fits
//   nearly any server (72 W, no extra power), the usual 48 GB data-centre card, and the most
//   memory available on one card.

// ── server generations ──
// channels: memory channels per processor. mts: speed the memory runs at (MT/s) unless a configuration says otherwise.
// isa: the best instruction set its processors have (amx > bf16 > avx512 > avx2). It decides how fast the processor part runs.
export const PLATFORMS = [
  { id: "skx", maker: "Intel", years: "2017 to 2020", name: "Xeon Scalable, 1st and 2nd generation", servers: "Dell PowerEdge R740 · HPE ProLiant DL380 Gen10 · Lenovo ThinkSystem SR650", channels: 6, mts: 2933, isa: "avx512", start: true },
  { id: "icx", maker: "Intel", years: "2021 to 2022", name: "Xeon Scalable, 3rd generation", servers: "Dell PowerEdge R750 · HPE ProLiant DL380 Gen10 Plus · Lenovo ThinkSystem SR650 V2", channels: 8, mts: 3200, isa: "avx512" },
  { id: "spr", maker: "Intel", years: "2023 to 2025", name: "Xeon Scalable, 4th and 5th generation", servers: "Dell PowerEdge R760 · HPE ProLiant DL380 Gen11 · Lenovo ThinkSystem SR650 V3", channels: 8, mts: 4800, isa: "amx" },
  { id: "gnr", maker: "Intel", years: "2025 to today", name: "Xeon 6", servers: "Dell PowerEdge R770 · HPE ProLiant DL380 Gen12 · Lenovo ThinkSystem SR650 V4", channels: 8, mts: 6400, isa: "amx" },
  { id: "hsw", maker: "Intel", years: "2014 to 2017", name: "Xeon E5 v3 and v4", servers: "Dell PowerEdge R730 · HPE ProLiant DL380 Gen9 · Lenovo System x3650 M5", channels: 4, mts: 2400, isa: "avx2" },
  { id: "zen3", maker: "AMD", years: "2019 to 2022", name: "EPYC 7002 and 7003", servers: "Dell PowerEdge R7525 · HPE ProLiant DL385 Gen10 Plus · Lenovo ThinkSystem SR665", channels: 8, mts: 3200, isa: "avx2" },
  { id: "zen4", maker: "AMD", years: "2022 to 2024", name: "EPYC 9004", servers: "Dell PowerEdge R7625 · HPE ProLiant DL385 Gen11 · Lenovo ThinkSystem SR665 V3", channels: 12, mts: 4800, isa: "bf16" },
  { id: "zen5", maker: "AMD", years: "2024 to today", name: "EPYC 9005", servers: "Dell PowerEdge R7725 · HPE ProLiant DL385 Gen11 · Lenovo ThinkSystem SR665 V3", channels: 12, mts: 6000, isa: "bf16" },
];

// ── the pool of configurations ──
// cores: per processor. ram: GB installed. extra.mts / extra.channels: where this set-up runs its memory
// slower, or leaves channels empty, compared with the generation's best.
const c = (id, platform, sockets, cpu, cores, ram, extra = {}) => ({ id, platform, sockets, cpu, cores, ram, ...extra });
export const CONFIGS = [
  c("skx-4210-96", "skx", 2, "Xeon Silver 4210", 10, 96, { mts: 2400, channels: 3 }),
  c("skx-5218-192", "skx", 2, "Xeon Gold 5218", 16, 192, { mts: 2666 }),
  c("skx-6130-384", "skx", 2, "Xeon Gold 6130", 16, 384, { mts: 2666 }),
  c("skx-6148-384", "skx", 2, "Xeon Gold 6148", 20, 384, { mts: 2666 }),
  c("skx-6230-384", "skx", 2, "Xeon Gold 6230", 20, 384, { start: true }),
  c("skx-6248r-768", "skx", 2, "Xeon Gold 6248R", 24, 768),
  c("skx-8280-768", "skx", 2, "Xeon Platinum 8280", 28, 768),
  c("skx-8280-1536", "skx", 2, "Xeon Platinum 8280", 28, 1536, { mts: 2666 }),

  c("icx-4314-128", "icx", 2, "Xeon Silver 4314", 16, 128, { mts: 2666, channels: 4 }),
  c("icx-4314-256", "icx", 2, "Xeon Silver 4314", 16, 256, { mts: 2666 }),
  c("icx-6330-512", "icx", 2, "Xeon Gold 6330", 28, 512, { mts: 2933 }),
  c("icx-6338-512", "icx", 2, "Xeon Gold 6338", 32, 512),
  c("icx-6338-1024", "icx", 2, "Xeon Gold 6338", 32, 1024),
  c("icx-8380-1024", "icx", 2, "Xeon Platinum 8380", 40, 1024),
  c("icx-8380-2048", "icx", 2, "Xeon Platinum 8380", 40, 2048),

  c("spr-4410-256", "spr", 2, "Xeon Silver 4410Y", 12, 256, { mts: 4000 }),
  c("spr-5418-256", "spr", 2, "Xeon Gold 5418Y", 24, 256, { mts: 4400 }),
  c("spr-6430-512", "spr", 2, "Xeon Gold 6430", 32, 512, { mts: 4400 }),
  c("spr-6448-512", "spr", 2, "Xeon Gold 6448Y", 32, 512),
  c("spr-8468-1024", "spr", 2, "Xeon Platinum 8468", 48, 1024),
  c("spr-6530-512", "spr", 2, "Xeon Gold 6530", 32, 512),
  c("spr-6548-1024", "spr", 2, "Xeon Gold 6548Y+", 32, 1024, { mts: 5200 }),
  c("spr-8568-2048", "spr", 2, "Xeon Platinum 8568Y+", 48, 2048),

  c("gnr-6520-256", "gnr", 2, "Xeon 6520P", 24, 256),
  c("gnr-6737-512", "gnr", 2, "Xeon 6737P", 32, 512),
  c("gnr-6747-1024", "gnr", 2, "Xeon 6747P", 48, 1024),
  c("gnr-6767-2048", "gnr", 2, "Xeon 6767P", 64, 2048, { mts: 5200 }),

  c("hsw-2650-128", "hsw", 2, "Xeon E5-2650 v4", 12, 128),
  c("hsw-2680-256", "hsw", 2, "Xeon E5-2680 v4", 14, 256),
  c("hsw-2690-512", "hsw", 2, "Xeon E5-2690 v4", 14, 512),

  c("zen3-7302p-128", "zen3", 1, "EPYC 7302P", 16, 128),
  c("zen3-7402p-256", "zen3", 1, "EPYC 7402P", 24, 256),
  c("zen3-7313-256", "zen3", 2, "EPYC 7313", 16, 256),
  c("zen3-7443-512", "zen3", 2, "EPYC 7443", 24, 512),
  c("zen3-7543-512", "zen3", 2, "EPYC 7543", 32, 512),
  c("zen3-7713-1024", "zen3", 2, "EPYC 7713", 64, 1024),
  c("zen3-7713-2048", "zen3", 2, "EPYC 7713", 64, 2048),

  c("zen4-9354p-384", "zen4", 1, "EPYC 9354P", 32, 384),
  c("zen4-9124-384", "zen4", 2, "EPYC 9124", 16, 384),
  c("zen4-9354-768", "zen4", 2, "EPYC 9354", 32, 768),
  c("zen4-9454-768", "zen4", 2, "EPYC 9454", 48, 768),
  c("zen4-9554-1536", "zen4", 2, "EPYC 9554", 64, 1536),

  c("zen5-9355p-384", "zen5", 1, "EPYC 9355P", 32, 384),
  c("zen5-9355-768", "zen5", 2, "EPYC 9355", 32, 768),
  c("zen5-9455-768", "zen5", 2, "EPYC 9455", 48, 768),
  c("zen5-9555-1536", "zen5", 2, "EPYC 9555", 64, 1536),
];

// ── the card ──
// price: US dollars, street, November 2026 (lowest tracked listings; they moved by double digits within months).
// slow: time the card needs per word next to a 24 GB flagship card (1 = the same). batch: how well it holds up with several people.
export const GPUS = [
  { id: "l4", name: "NVIDIA L4", vram: 24, price: [3400, 3900], fit: "Low-profile, single slot, 72 W, powered by the slot itself. Fits nearly any rack server.", slow: 2.7, batch: 0.6 },
  { id: "l40s", name: "NVIDIA L40S", vram: 48, price: [7200, 8200], fit: "Double-width, 350 W. The server needs a free double-width slot and its card power kit.", slow: 1.0, batch: 1.0, start: true },
  { id: "pro6000", name: "NVIDIA RTX PRO 6000 Blackwell", vram: 96, price: [16000, 21000], fit: "Double-width, up to 600 W. For servers built to take large cards. The most memory on one card.", slow: 0.72, batch: 1.1 },
];

// ── the models, largest first ──
// Only models the technology documents as running on one card. (Larger 2026 models exist, up to
// 2.8 trillion parameters, but need more memory than these servers hold and are not supported yet.)
// ram: GB of server memory needed. vram: GB the card must have.
// readGB: GB the processor reads from memory for each word (active specialists x bytes per weight).
// expertsGB: size of all the specialists together. cardMs: the card's own time per word, ms, on the reference card.
// isa: instruction sets it runs on. fullVram: GB of card memory a GPU-only server needs to hold it.
export const MODELS = [
  { id: "kimi-k2.5", name: "Kimi K2.5", size: "about 1 trillion parameters",
    blurb: "A trillion-parameter model, among the largest that can be run outside a data centre.",
    ram: 640, vram: 48, readGB: 11.4, expertsGB: 560, cardMs: 15, isa: ["amx", "bf16", "avx512", "avx2"], fullVram: 680 },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", size: "about 320 billion parameters",
    blurb: "A 320-billion-parameter model that takes in very long documents, images and video.",
    ram: 350, vram: 24, readGB: 13.5, expertsGB: 290, cardMs: 12, isa: ["amx", "bf16"], fullVram: 360 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", size: "about 300 billion parameters",
    blurb: "A 300-billion-parameter model from 2026 with step-by-step reasoning and tool use.",
    ram: 200, vram: 24, readGB: 5.2, expertsGB: 150, cardMs: 42, isa: ["amx", "bf16", "avx512", "avx2"], fullVram: 185 },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", size: "80 billion parameters",
    blurb: "An 80-billion-parameter model built for writing and reviewing code.",
    ram: 100, vram: 24, readGB: 2.25, expertsGB: 72, cardMs: 7.5, isa: ["amx", "bf16", "avx512", "avx2"], fullVram: 92 },
  { id: "qwen3.5-35b", name: "Qwen3.5 35B", size: "35 billion parameters",
    blurb: "A compact 35-billion-parameter general model.",
    ram: 48, vram: 24, readGB: 2.25, expertsGB: 30, cardMs: 6, isa: ["amx", "bf16", "avx512", "avx2"], fullVram: 42 },
];

// ── GPU-only servers, for the cost comparison: smallest first ──
// Purchase prices, complete server, November 2026. The two larger ones rest on dealer listings and
// resale-value trackers; the two smaller ones are card prices plus a server to hold them, so treat them as rougher.
export const FULL_GPU = [
  { vram: 96, name: "Two 48 GB cards, or one 96 GB card, in a server built for them", price: [28000, 40000] },
  { vram: 192, name: "Four 48 GB data-centre cards in a GPU server (192 GB)", price: [50000, 65000] },
  { vram: 384, name: "Four 96 GB cards in a GPU server (384 GB)", price: [105000, 130000] },
  { vram: 768, name: "Eight 96 GB cards in a GPU server (768 GB)", price: [200000, 240000] },
  { vram: 1128, name: "Eight 141 GB data-centre cards in a GPU server (1,128 GB)", price: [300000, 450000] },
];
