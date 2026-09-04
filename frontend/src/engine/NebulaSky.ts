import * as THREE from "three";
import {
  SKY_BAND_COLOR,
  SKY_BRIGHTNESS,
  SKY_CARDINAL_COLORS,
  SKY_FACE_PX,
  SKY_KNOT_COLOR,
  SKY_SEED,
} from "../config.ts";

/**
 * Vertex stage. The sky box is a unit cube around the cube camera, so the
 * interpolated object-space position IS the view direction (normalized in the
 * fragment stage; a box's face is flat, so the interpolated vector is not unit
 * length, but its direction is exact).
 */
const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
	vDir = position;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/**
 * Fragment stage — the whole sky from a direction, in linear light. Layers:
 *
 * 1. **Cardinal hue.** Six colours blended by the squared direction
 *    components. On the unit sphere `x^2 + y^2 + z^2 == 1`, so the six weights
 *    (each axis split into its positive and negative half) sum to exactly one
 *    everywhere — no normalization, no seams, and a diagonal is an even mix of
 *    its two neighbours. This is the compass: it decides what colour a nebula
 *    in a given direction can be.
 *
 * 2. **Nebula density.** Two fBm fields (5 octaves of value noise; `hash13`
 *    is the "hash without sine" construction, chosen because it keeps its
 *    quality at the lattice coordinates the higher octaves reach, where the
 *    `fract(sin())` folk hash breaks down in fp32). A low-frequency `mass`
 *    field thresholded to a few broad lobes picks WHERE the nebulae are, so
 *    most of the sky stays near-black and the coloured regions read as
 *    distinct objects rather than an all-over tint; a mid-frequency `wisp`
 *    field textures them. A small `wisp` floor keeps every direction faintly
 *    non-black so the eye always has something to compare the next direction
 *    against. The nadir is scaled down to be the darkest region.
 *
 * 3. **Band.** A Gaussian around a great circle whose plane contains +Y (its
 *    normal is horizontal), so it arcs from horizon to horizon through the
 *    zenith, weighted to the upper hemisphere so it never shows below. The
 *    tilt of the plane is fixed, not seeded — it is a landmark.
 *
 * 4. **Knots.** Four galaxy-like blobs at fixed bearings: a Gaussian in
 *    `1 - cos(angle)` (which is `angle^2 / 2` for small angles, so `KNOT_SPREAD`
 *    is half the square of the angular radius in radians), each an elongated
 *    ellipse (scaled along a fixed in-sky axis) with a small bright core, tinted
 *    by the cardinal hue where it sits. Fixed bearings for the same reason as
 *    the band: a landmark you can steer by has to stay put across seeds.
 *
 * Output is linear light: the cube render target is sRGB-encoded (see the
 * class doc), so the GPU applies the transfer function on write and the
 * background shader's sample is decoded back to linear for free.
 */
const SKY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uSeed;
uniform float uBrightness;
uniform vec3 uCardinal[ 6 ];
uniform vec3 uBandColor;
uniform vec3 uKnotColor;
varying vec3 vDir;

float hash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}

float valueNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( hash13( i ), hash13( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
		     mix( hash13( i + vec3( 0.0, 1.0, 0.0 ) ), hash13( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
		mix( mix( hash13( i + vec3( 0.0, 0.0, 1.0 ) ), hash13( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
		     mix( hash13( i + vec3( 0.0, 1.0, 1.0 ) ), hash13( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
		f.z );
}

// Five octaves, lacunarity ~2, gain 0.5, normalized to [0, 1].
float fbm( vec3 p ) {
	float sum = 0.0;
	float amp = 0.5;
	float norm = 0.0;
	for ( int i = 0; i < 5; i ++ ) {
		sum += amp * valueNoise( p );
		norm += amp;
		p = p * 2.02 + vec3( 3.7, 1.9, 5.3 );
		amp *= 0.5;
	}
	return sum / norm;
}

// An elongated Gaussian blob around bearing 'dir', stretched 'stretch'x along
// 'axis' (an in-sky direction; its component along 'dir' is removed).
float knot( vec3 d, vec3 dir, vec3 axis, float spread, float stretch ) {
	vec3 off = d - dir * dot( d, dir );
	vec3 a = normalize( axis - dir * dot( axis, dir ) );
	float along = dot( off, a ) / stretch;
	vec3 rest = off - dot( off, a ) * a;
	float r2 = along * along + dot( rest, rest );
	return exp( - r2 / spread );
}

void main() {
	vec3 d = normalize( vDir );
	vec3 seed = vec3( uSeed, uSeed * 0.5, uSeed * 0.25 );

	// 1. cardinal hue
	vec3 wp = max( d, 0.0 );
	vec3 wn = max( - d, 0.0 );
	wp *= wp;
	wn *= wn;
	vec3 hue = uCardinal[ 0 ] * wp.x + uCardinal[ 1 ] * wn.x
	         + uCardinal[ 2 ] * wp.y + uCardinal[ 3 ] * wn.y
	         + uCardinal[ 4 ] * wp.z + uCardinal[ 5 ] * wn.z;

	// 2. nebula density
	float mass = fbm( d * 1.6 + seed );
	float wisp = fbm( d * 4.5 + seed * 2.0 + 7.0 );
	float density = smoothstep( 0.42, 0.72, mass ) * ( 0.35 + 0.65 * smoothstep( 0.3, 0.8, wisp ) );
	density += 0.06 * wisp;
	density *= mix( 0.35, 1.0, smoothstep( - 0.9, 0.1, d.y ) );
	vec3 col = hue * density;

	// 3. the band overhead
	const vec3 bandNormal = vec3( 0.6220, 0.0, 0.7830 );
	float bandDist = dot( d, bandNormal );
	float band = exp( - bandDist * bandDist / ( 2.0 * 0.085 * 0.085 ) );
	band *= smoothstep( - 0.15, 0.55, d.y );
	float bandTex = 0.45 + 0.55 * fbm( d * 6.0 + seed + 11.0 );
	col += uBandColor * band * bandTex * 0.5;

	// 4. galaxy knots — fixed bearings, one per quadrant-ish, none at the nadir
	const float KNOT_SPREAD = 0.0035;
	float k = 0.0;
	k += knot( d, vec3( 0.7480, 0.3206, 0.5810 ), vec3( 0.0, 1.0, 0.0 ), KNOT_SPREAD, 2.2 );
	k += knot( d, vec3( -0.5606, -0.2242, 0.7970 ), vec3( 1.0, 0.0, 0.0 ), KNOT_SPREAD, 1.8 );
	k += knot( d, vec3( 0.2050, 0.6150, -0.7613 ), vec3( 1.0, 0.0, 0.0 ), KNOT_SPREAD, 2.6 );
	k += knot( d, vec3( -0.8846, 0.1106, -0.4531 ), vec3( 0.0, 1.0, 0.0 ), KNOT_SPREAD, 1.6 );
	float core = k * k;
	col += mix( hue, uKnotColor, 0.55 ) * k * ( 0.6 + 0.4 * wisp ) * 0.5 + uKnotColor * core * 0.3;

	gl_FragColor = vec4( col * uBrightness, 1.0 );
}
`;

/**
 * The procedural nebula backdrop: a cubemap rendered ONCE (at construction,
 * and again on `regenerate`) into a `WebGLCubeRenderTarget`, then set as
 * `scene.background` by `Engine`. Per frame it costs one cubemap lookup per
 * background pixel — three draws a background cube first, depth test off, in
 * its own unfogged material — and nothing else.
 *
 * What it is for: navigation. In the plain clear colour every direction looks
 * the same, so after a few turns you have no idea which way the densest
 * cluster went. With a different hue at each cardinal (see
 * `SKY_CARDINAL_COLORS`), a band overhead and a handful of knots at fixed
 * bearings, the sky is a compass — "navigate by the stars". It is NOT scenery:
 * `SKY_BRIGHTNESS` keeps it dark enough that the cubes and the cyan HUD stay
 * the brightest things on screen.
 *
 * Interaction with the rest of the environment:
 *
 * - **Starfield.** Unchanged and drawn on top: the background goes first and
 *   writes no depth; the stars are a world-space shell in the transparent
 *   pass, additive, so they sit over the nebulae exactly as they sat over the
 *   void. The two are complementary — stars give parallax when you translate,
 *   the nebulae give bearing when you turn.
 * - **Fog.** Not applied: three's background materials are `fog: false`, so
 *   the sky is never pulled toward `FOG_COLOR`. Geometry at the limit of the
 *   fog fades to `FOG_COLOR`, which is a few points darker than the dimmest
 *   nebula, so a fully-fogged block is a faint silhouette against the glow
 *   rather than gone — see `FOG_COLOR`.
 *
 * The render target is sRGB (`SRGBColorSpace`, unsigned bytes): the shader
 * writes linear light and the GPU applies the sRGB transfer on write, which
 * matters at this brightness — the whole sky lives in the bottom 20% of the
 * range, where a linear 8-bit target has only ~8 distinguishable levels and
 * every gradient would band. Half-float would also work at 4x the bytes.
 */
export class NebulaSky {
  readonly target: THREE.WebGLCubeRenderTarget;
  readonly material: THREE.ShaderMaterial;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.CubeCamera;
  private readonly geometry: THREE.BoxGeometry;
  private readonly mesh: THREE.Mesh;
  private currentSeed = SKY_SEED;

  constructor(renderer: THREE.WebGLRenderer, seed = SKY_SEED) {
    this.renderer = renderer;
    this.target = new THREE.WebGLCubeRenderTarget(SKY_FACE_PX, {
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    // A one-metre box around a camera at its centre; near/far just have to
    // bracket the box's faces (0.5 away, 0.87 at the corners).
    this.camera = new THREE.CubeCamera(0.1, 2, this.target);

    const toLinear = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSeed: { value: 0 },
        uBrightness: { value: SKY_BRIGHTNESS },
        uCardinal: { value: SKY_CARDINAL_COLORS.map(toLinear) },
        uBandColor: { value: toLinear(SKY_BAND_COLOR) },
        uKnotColor: { value: toLinear(SKY_KNOT_COLOR) },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.regenerate(seed);
  }

  /** The cubemap, for `scene.background`. */
  get texture(): THREE.CubeTexture {
    return this.target.texture;
  }

  /** The seed the current cubemap was rendered from. */
  get seed(): number {
    return this.currentSeed;
  }

  /**
   * Re-renders the cubemap from `seed` (default: the current one, e.g. after
   * tweaking `material.uniforms` from the console). The seed is folded into
   * [0, 1000) before it reaches the shader: the noise lattice is sampled at
   * `direction * frequency + seed`, and fp32 hashing degrades once the lattice
   * coordinate is in the tens of thousands.
   */
  regenerate(seed = this.currentSeed): void {
    this.currentSeed = seed;
    this.material.uniforms.uSeed.value = ((seed % 1000) + 1000) % 1000;
    this.camera.update(this.renderer, this.scene);
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
