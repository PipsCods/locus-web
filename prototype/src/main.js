// The pond (three.js) is loaded after the page text is up. Without WebGL the page still reads:
// flat logo in the hero, and "How it works" as its title and one line of text.
// ?art=ink / ?art=paper: the illustrated versions of the pond (see art.js). The page takes its colours from the class set here.
const art = new URLSearchParams(location.search).get("art");
if (art !== null) {
  document.body.classList.add("art", art === "paper" ? "art-paper" : "art-ink");
  if (art === "paper") document.querySelector(".nav__logo img")?.setAttribute("src", "/locus-wordmark-dark.svg");
}
const host = document.querySelector(".pond");
const how = document.querySelector("#how");
if (host && how) {
  import("./world.js").then((m) => {
    const world = m.initWorld({
      host,
      how,
      dom: {
        labels: document.querySelectorAll(".pond-labels [data-anchor]"),
        answer: how.querySelector("[data-answer]"),
      },
    });
    if (!world) return;
    document.body.classList.add("has-pond");
    document.documentElement.classList.add("pond-snap"); // the page now rests on the lotus or on the story, never between (see style.css)
    if (import.meta.env.DEV) {
      // test aids, left out of the published site: the scene's controls, and a still-capture switch
      // ?demo=<how far to scroll, 0..1>,<seconds to fast-forward>
      window.__world = world;
      const demo = new URLSearchParams(location.search).get("demo");
      if (demo) {
        const [where, secs] = demo.split(",").map(Number);
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(0, (how.offsetTop - 64) * where);
        world.play(secs || 0.5, 1 / 30);
      }
    }
  });
}
