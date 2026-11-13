// The pond (three.js) is loaded after the page text is up. Without WebGL the page still reads:
// flat logo in the hero, and "How it works" as plain text and steps.
const host = document.querySelector(".pond");
const how = document.querySelector("#how");
if (host && how) {
  import("./world.js").then((m) => {
    const world = m.initWorld({
      host,
      how,
      dom: {
        labels: document.querySelectorAll(".pond-labels [data-anchor]"),
        steps: how.querySelectorAll("[data-step]"),
        narrate: how.querySelector("[data-narrate]"),
        answer: how.querySelector("[data-answer]"),
      },
    });
    if (world) { document.body.classList.add("has-pond"); window.__world = world; }
    // still-capture switch: ?demo=<how far to scroll, 0..1>,<seconds to fast-forward>
    const demo = new URLSearchParams(location.search).get("demo");
    if (world && demo) {
      const [where, secs] = demo.split(",").map(Number);
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, (how.offsetTop - 60) * where);
      world.play(secs || 0.5, 1 / 30);
    }
  });
}
