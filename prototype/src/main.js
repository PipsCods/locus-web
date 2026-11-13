import { initHero } from "./hero.js";

initHero();

// three.js is only needed for the scene further down the page, so load it separately.
const scene = document.querySelector("[data-scene]");
if (scene) import("./scene.js").then((m) => m.initScene(scene));
