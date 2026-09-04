import * as THREE from "three";
import {
  STARFIELD_COLOR,
  STARFIELD_COUNT,
  STARFIELD_OPACITY,
  STARFIELD_RADIUS_WORLD_SCALES,
  STARFIELD_SIZE_PX,
  WORLD_SCALE,
} from "../config.ts";

/**
 * Deterministic 32-bit PRNG (mulberry32). A seeded generator rather than
 * `Math.random()` so the sky is byte-identical across reloads: this matters for
 * the headless screenshot comparisons the project verifies changes with (a
 * random sky would put a different noise pattern in every "before"/"after"
 * pair), and it means a star someone noticed is still there next session.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The sparse starfield backdrop: a shell of dim points at a radius far outside
 * the play area, giving the void something to be measured against.
 *
 * Why this exists at all: in a pure black void a camera translating at 16
 * units/s and a camera sitting still look identical wherever data isn't in
 * frame, and there is no cue for how far away an isolated cluster is. Every
 * space-flight game in this project's reference set (Descent, Elite, No Man's
 * Sky) solves that the same cheap way. The fog added alongside this
 * (`Engine`'s `FogExp2`) covers absolute distance; the stars cover *motion*,
 * and the nebula sky behind them (`NebulaSky.ts`, Phase 7) covers *bearing* —
 * between them they are all that's on screen when you're crossing empty space.
 *
 * Deliberate choices:
 *
 * - **Fixed world positions, not pinned to the camera.** A camera-pinned
 *   skybox conveys rotation but not translation. At a 600-unit radius, crossing
 *   the 100-unit world sweeps the near stars by ~9.5° — small, but it's real
 *   parallax, and it's what makes flight feel like travel rather than the world
 *   sliding past.
 * - **`fog: false`.** Stars are notionally at infinity; letting the scene's
 *   FogExp2 eat them would delete the backdrop exactly where it's needed (the
 *   density at 600 units is effectively total).
 * - **`sizeAttenuation: false`.** At 600 units a perspective-scaled point is
 *   sub-pixel and aliases into a flickering mess as the camera turns. A
 *   constant pixel size is also what makes them read as *distant* rather than
 *   as nearby dust.
 * - **`depthWrite: false` + `transparent: true`.** The shell is the farthest
 *   thing in the scene, so three's back-to-front transparent sort draws it
 *   first, and with depth testing still on, any voxel — textured or proxy — in
 *   front of a star correctly occludes it, with no depth buffer pollution.
 * - **Per-star brightness via vertex colors.** A field of identically bright
 *   dots reads as a regular texture/screen artifact; varied magnitudes read as
 *   a sky. The distribution is biased dim (x^2.2) so only a handful are at full
 *   `STARFIELD_OPACITY`.
 */
export class Starfield {
  readonly points: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;

  constructor(seed = 0x5eed1234) {
    const random = mulberry32(seed);
    const radius = STARFIELD_RADIUS_WORLD_SCALES * WORLD_SCALE;

    const positions = new Float32Array(STARFIELD_COUNT * 3);
    const colors = new Float32Array(STARFIELD_COUNT * 3);
    const base = new THREE.Color(STARFIELD_COLOR);

    for (let i = 0; i < STARFIELD_COUNT; i++) {
      // Uniform on the sphere: z uniform in [-1,1] plus a uniform azimuth
      // (Archimedes). Sampling latitude/longitude uniformly instead would pile
      // stars up at the poles, which is visible as two bright patches.
      const z = random() * 2 - 1;
      const azimuth = random() * Math.PI * 2;
      const ring = Math.sqrt(Math.max(0, 1 - z * z));
      // ±12% radius jitter so the shell has some depth to it and never lines
      // up into a visible sphere surface when flying near the world's edge.
      const r = radius * (0.88 + 0.24 * random());
      positions[i * 3] = r * ring * Math.cos(azimuth);
      positions[i * 3 + 1] = r * z;
      positions[i * 3 + 2] = r * ring * Math.sin(azimuth);

      const brightness = 0.25 + 0.75 * Math.pow(random(), 2.2);
      // Slight per-star hue drift toward warm/cool, same trick a real sky has.
      const warmth = 0.9 + 0.2 * random();
      colors[i * 3] = base.r * brightness * warmth;
      colors[i * 3 + 1] = base.g * brightness;
      colors[i * 3 + 2] = base.b * brightness * (2 - warmth);
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.PointsMaterial({
      size: STARFIELD_SIZE_PX,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: STARFIELD_OPACITY,
      depthWrite: false,
      fog: false,
      // Stars are emissive light against a near-black ground; additive keeps
      // them from looking like grey paint where two happen to overlap.
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = "starfield";
    // The shell's bounding sphere is centred on the origin and the camera can
    // be anywhere inside it, which is precisely the case three's frustum test
    // handles correctly — but the whole object is one draw call of 1,400
    // points, so there is nothing to gain by culling it and a real (invisible)
    // failure mode if a future change moves it. Keep it simple and always draw.
    this.points.frustumCulled = false;
    // Behind everything: renderOrder is only consulted within the transparent
    // pass, where this is already the farthest object, but pinning it makes the
    // intent explicit and survives anything else claiming a renderOrder later
    // (the container cages use 1, the minimap flashlight and hover box 2).
    this.points.renderOrder = -1;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
