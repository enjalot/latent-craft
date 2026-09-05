import * as THREE from "three";

/** Small, baked lighting-only environment: broad warm key and cool strip.
 * Never drawn in the world; no per-frame capture, shadow maps or postprocess.
 * Engine owns the returned target (including its filtered mip chain). */
export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10131c);
  const geometry = new THREE.PlaneGeometry(1, 1);
  const cards: THREE.Mesh[] = [];
  for (const [position, size, color, intensity] of [
    [[4, 6, 3], [4, 6], 0xffeedb, 4.5],
    [[-5, 1, -3], [2, 7], 0xa5d9ff, 3.5],
    [[0, -4, 2], [5, 2], 0xaab8ce, 1.2],
  ] as const) {
    const material = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    material.color.multiplyScalar(intensity);
    const card = new THREE.Mesh(geometry, material);
    card.position.set(position[0], position[1], position[2]);
    card.scale.set(size[0], size[1], 1);
    card.lookAt(0, 0, 0);
    scene.add(card);
    cards.push(card);
  }
  const generator = new THREE.PMREMGenerator(renderer);
  try {
    return generator.fromScene(scene, 0, .1, 30, { size: 128 });
  } finally {
    generator.dispose();
    geometry.dispose();
    for (const card of cards) (card.material as THREE.Material).dispose();
  }
}
