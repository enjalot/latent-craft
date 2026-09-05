import * as THREE from "three";
import { ATLAS_TILE_INSET_TEXELS } from "../config.ts";

/** Immediate opaque 32px fallback for X-ray hover; the sharp pool replaces it
 * with 128px when ready. Reuses the source atlas, never downloads an image. */
export class OpaqueHover {
  readonly mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ toneMapped: false }));
  private readonly tile = { value: 0 };
  private readonly side = { value: 1 };
  private readonly inset = { value: .5 / 32 };

  constructor(scene: THREE.Scene) {
    this.mesh.visible = false; this.mesh.matrixAutoUpdate = false; this.mesh.frustumCulled = false;
    this.mesh.name = "xray-opaque-hover"; this.mesh.raycast = () => {};
    this.mesh.material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, { hoverTile:this.tile, hoverSide:this.side, hoverInset:this.inset });
      shader.fragmentShader = `uniform float hoverTile, hoverSide, hoverInset;\n${shader.fragmentShader}`
        .replace("#include <map_fragment>", `
          #ifdef USE_MAP
            vec2 p = clamp(vMapUv, hoverInset, 1.0-hoverInset);
            vec2 uv = (vec2(mod(hoverTile,hoverSide),floor(hoverTile/hoverSide)) + vec2(p.x,1.0-p.y))/hoverSide;
            diffuseColor *= texture2D(map,uv);
          #endif
        `);
    };
    this.mesh.material.customProgramCacheKey = () => "opaque-hover-atlas-v1";
    scene.add(this.mesh);
  }

  show(matrix: THREE.Matrix4, atlas: THREE.Texture, tile: number, side: number, tilePx: number): void {
    if (!this.mesh.material.map) this.mesh.material.needsUpdate = true;
    this.mesh.material.map = atlas;
    this.tile.value = tile; this.side.value = side; this.inset.value = ATLAS_TILE_INSET_TEXELS / tilePx;
    this.mesh.matrix.copy(matrix); this.mesh.matrixWorldNeedsUpdate = true; this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose();
  }
}
