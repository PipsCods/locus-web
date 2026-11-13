// Bakes the plain meshes under a group into one mesh per material, so a model built from many
// small parts is drawn in a handful of calls instead of one call per part. Parts that move on
// their own must be kept out: put them in a group flagged `userData.live = true`.
// Instanced meshes and lines are left alone.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const KEEP = ["position", "normal", "uv"];

export function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4();
  const buckets = new Map();
  (function walk(o) {
    for (const c of o.children) {
      if (c.userData.live) continue;
      if (c.isMesh && !c.isInstancedMesh && !Array.isArray(c.material)) {
        const key = `${c.material.uuid}|${c.castShadow}|${c.receiveShadow}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(c);
      }
      walk(c);
    }
  })(root);

  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const parts = list.map((m) => {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
      return g.applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld));
    });
    const merged = mergeGeometries(parts, false);
    if (!merged) continue; // parts that cannot be joined simply stay as they were
    const mesh = new THREE.Mesh(merged, list[0].material);
    mesh.castShadow = list[0].castShadow;
    mesh.receiveShadow = list[0].receiveShadow;
    for (const m of list) m.removeFromParent();
    root.add(mesh);
  }

  const empty = [];
  root.traverse((o) => { if (o !== root && o.type === "Group" && o.children.length === 0) empty.push(o); });
  for (const o of empty) o.removeFromParent();
  return root;
}
