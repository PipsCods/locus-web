// Vast offer search with tiered RAM fallback. One search at the lowest tier, then pick locally:
// highest RAM tier that has an offer, preferring server CPUs (cpu_name is not a server-side filter),
// then the cheapest. Machines already tried for this demo are skipped.

export function offerQuery(cfg) {
  const minTierGb = Math.min(...cfg.vastRamTiersGb);
  return {
    limit: 64,
    type: "ondemand",
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    num_gpus: { eq: 1 },
    gpu_name: { eq: cfg.vastGpuName },
    reliability: { gt: cfg.vastMinReliability },
    inet_down: { gte: cfg.vastMinInetDown },
    // REST cpu_ram is MB. ×1000 (not 1024) so a "192 GB" host reporting e.g. 193000 MB still matches.
    cpu_ram: { gte: minTierGb * 1000 },
    disk_space: { gte: cfg.vastDiskGb },
    dph_total: { lte: cfg.vastMaxDph },
    order: [["dph_total", "asc"]],
  };
}

export function pickOffer(offers, { tiersGb, exclude = [], preferCpu = [] }) {
  const skip = new Set(exclude.map(Number));
  const prefers = (o) => preferCpu.some((p) => String(o.cpu_name ?? "").toLowerCase().includes(p.toLowerCase()));
  const usable = offers.filter((o) => o && o.id && !skip.has(Number(o.machine_id)) && o.num_gpus === 1 && o.verified !== false);
  for (const tier of [...tiersGb].sort((a, b) => b - a)) {
    const fit = usable.filter((o) => Number(o.cpu_ram) >= tier * 1000);
    if (!fit.length) continue;
    fit.sort((a, b) => Number(prefers(b)) - Number(prefers(a)) || Number(a.dph_total) - Number(b.dph_total));
    return { offer: fit[0], tierGb: tier };
  }
  return null;
}

/** What the status page shows, read from the offer that was rented. */
export const hardwareOf = (o) => ({
  cpu: String(o.cpu_name ?? "").trim() || "Server CPU",
  ram_gb: Math.round(Number(o.cpu_ram ?? 0) / 1024),
  gpu: `${o.num_gpus ?? 1}× ${String(o.gpu_name ?? "GPU").replace(/_/g, " ")}`,
});
