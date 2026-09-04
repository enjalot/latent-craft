import * as THREE from "three";
import {
  SKY_BAND_BRIGHTNESS,
  SKY_BAND_COLOR,
  SKY_CARDINAL_COLORS,
  SKY_FACE_PX,
  SKY_GALAXIES,
  SKY_GALAXY_BRIGHTNESS,
  SKY_GALAXY_CORE_COLOR,
  SKY_NEBULA_BRIGHTNESS,
  SKY_SEED,
  SKY_SWIRLS,
  type SkyBearing,
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
 * Fragment stage — the whole sky from a direction, in linear light. Everything
 * is a function of the unit direction `d` alone (never of face-space
 * coordinates), which is what makes the six faces seamless. Layers:
 *
 * 1. **Cardinal hue.** Six colours blended by the squared direction
 *    components. On the unit sphere `x^2 + y^2 + z^2 == 1`, so the six weights
 *    (each axis split into its positive and negative half) sum to exactly one
 *    everywhere — no normalization, no seams, and a diagonal is an even mix of
 *    its two neighbours. This is the compass: it decides what colour a nebula
 *    in a given direction can be.
 *
 * 2. **Swirl.** Before any noise is sampled, the sampling direction is twisted
 *    about each `SKY_SWIRLS` centre (Rodrigues rotation about the centre's
 *    axis) by an angle that falls from `twist` at the centre to zero at
 *    `radius`. Rotating about the centre preserves the angle TO the centre, so
 *    this is a pure twirl: every ring around the centre turns by its own
 *    amount, and the difference between neighbouring rings shears whatever
 *    noise is sampled afterwards into arcs around the centre — the eye reads
 *    it as a vortex. Each centre also contributes a broad Gaussian "lobe" that
 *    makes the nebula densest where it whirls, so the swirl is on the bright
 *    part, not the empty part.
 *
 * 3. **Nebula.** Two-level domain-warped fBm (`fbm(p + k1 * fbm3(p + k2 *
 *    fbm3(p)))`, the Quilez construction; `fbm3` is a three-channel fBm from a
 *    `hash33` so one lattice walk yields the whole warp vector) sampled at the
 *    swirled direction. The warp bends the noise into filaments and wisps;
 *    thresholding it gives bright strands against dark lanes. A low-frequency
 *    `mass` field thresholded to a few broad lobes, OR'd with the swirl lobes,
 *    picks WHERE the nebulae are, so most of the sky stays dark and the
 *    coloured regions read as objects. A small floor keeps every direction
 *    faintly coloured so there is always a hue to compare against; the nadir is
 *    scaled down to be the darkest region. `hash13` / `hash33` are the "hash
 *    without sine" constructions, chosen because they keep their quality at the
 *    lattice coordinates the higher octaves reach, where `fract(sin())` breaks
 *    down in fp32.
 *
 * 4. **Band.** A Gaussian around a great circle whose plane contains +Y (its
 *    normal is horizontal), so it arcs from horizon to horizon through the
 *    zenith, weighted to the upper hemisphere so it never shows below. Textured
 *    by the same warped field plus a higher-frequency dust term that cuts dark
 *    lanes through it, the way the real Milky Way is split by dust. Fixed, not
 *    seeded — it is a landmark.
 *
 * 5. **Galaxies.** `SKY_GALAXIES`: at each bearing a local tangent frame
 *    (`u`, `v`) is built on the CPU; the direction is projected into it and the
 *    minor axis divided by the axis ratio, which turns an inclined disc into a
 *    circle in `(x, y)`. In polar coordinates of that circle the arms are a
 *    logarithmic spiral, `phase = arms * theta - winding * log(r)`, jittered by
 *    noise so they clump and break; `cos(phase)` raised to a power narrows them;
 *    they are faded out inside the bulge and with radius; a compact core sits
 *    at the centre and a dust lane runs along the major axis of the more
 *    inclined ones. The disc has an edge — an elliptical window takes the
 *    haze to exactly zero by six scale lengths, and the noise is skipped
 *    beyond that — because the arm profile alone decays too slowly to be cut
 *    off anywhere without drawing a circle. Tinted by the local cardinal hue
 *    with a near-white core. Fixed bearings, deterministic by `SKY_SEED` — a
 *    landmark you steer by has to stay put across seeds.
 *
 * The three layers have independent brightness uniforms (`SKY_NEBULA_
 * BRIGHTNESS`, `SKY_BAND_BRIGHTNESS`, `SKY_GALAXY_BRIGHTNESS`) because they
 * want different exposures: the nebulae have to be bright enough to read a
 * hue at a glance, the band and galaxies have to stay accents.
 *
 * Output is linear light: the cube render target is sRGB-encoded (see the
 * class doc), so the GPU applies the transfer function on write and the
 * background shader's sample is decoded back to linear for free.
 */
const SKY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#define SWIRL_COUNT ${SKY_SWIRLS.length}
#define GALAXY_COUNT ${SKY_GALAXIES.length}

uniform float uSeed;
uniform float uNebulaBrightness;
uniform float uBandBrightness;
uniform float uGalaxyBrightness;
uniform vec3 uCardinal[ 6 ];
uniform vec3 uBandColor;
uniform vec3 uGalaxyCoreColor;
// xyz = centre direction, w = twist angle at the centre (radians)
uniform vec4 uSwirl[ SWIRL_COUNT ];
// angular radius of each swirl (radians)
uniform float uSwirlRadius[ SWIRL_COUNT ];
uniform vec3 uGalaxyDir[ GALAXY_COUNT ];
uniform vec3 uGalaxyU[ GALAXY_COUNT ];
uniform vec3 uGalaxyV[ GALAXY_COUNT ];
// x = disc scale length (radians), y = axis ratio, z = arm count, w = winding (signed)
uniform vec4 uGalaxyParam[ GALAXY_COUNT ];
varying vec3 vDir;

float hash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}

vec3 hash33( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.xxy + p.yxx ) * p.zyx );
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

vec3 valueNoise3( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( hash33( i ), hash33( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
		     mix( hash33( i + vec3( 0.0, 1.0, 0.0 ) ), hash33( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
		mix( mix( hash33( i + vec3( 0.0, 0.0, 1.0 ) ), hash33( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
		     mix( hash33( i + vec3( 0.0, 1.0, 1.0 ) ), hash33( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
		f.z );
}

// Lacunarity ~2, gain 0.5, normalized to [0, 1].
float fbm( vec3 p, int octaves ) {
	float sum = 0.0;
	float amp = 0.5;
	float norm = 0.0;
	for ( int i = 0; i < octaves; i ++ ) {
		sum += amp * valueNoise( p );
		norm += amp;
		p = p * 2.02 + vec3( 3.7, 1.9, 5.3 );
		amp *= 0.5;
	}
	return sum / norm;
}

// Three independent fBm channels from one lattice walk, centred on zero.
vec3 fbm3( vec3 p, int octaves ) {
	vec3 sum = vec3( 0.0 );
	float amp = 0.5;
	float norm = 0.0;
	for ( int i = 0; i < octaves; i ++ ) {
		sum += amp * valueNoise3( p );
		norm += amp;
		p = p * 2.02 + vec3( 3.7, 1.9, 5.3 );
		amp *= 0.5;
	}
	return sum / norm - 0.5;
}

// Two-level domain warp: the wisp/filament field.
float warpedField( vec3 p, vec3 seed ) {
	vec3 q = fbm3( p + seed, 4 );
	vec3 r = fbm3( p + 2.4 * q + vec3( 1.7, 9.2, 4.1 ) + seed * 0.7, 4 );
	return fbm( p + 2.8 * r + vec3( 8.3, 2.8, 6.4 ), 5 );
}

// Rodrigues rotation of v about unit axis k by angle a.
vec3 rotateAbout( vec3 v, vec3 k, float a ) {
	float c = cos( a );
	float s = sin( a );
	return v * c + cross( k, v ) * s + k * dot( k, v ) * ( 1.0 - c );
}

// The disc's edge, in scale lengths: the arm haze is windowed to zero here
// (the 'edge' term in galaxy()), and galaxy()'s early-out is derived from it.
#define GALAXY_EDGE_R 6.0

// One spiral galaxy. Returns the disc + arm intensity (0..~1.5) and writes
// the compact core separately so it can take its own colour.
float galaxy( vec3 d, vec3 g, vec3 u, vec3 v, vec4 prm, vec3 seed, out float core ) {
	core = 0.0;
	float along = dot( d, g );
	float scale = prm.x;
	// Skip the noise where the window below is already zero. The tangent
	// offset has length sin(angle) and r >= sin(angle) / scale (the minor
	// axis only stretches r), so r >= GALAXY_EDGE_R everywhere past
	// asin(GALAXY_EDGE_R * scale) — 32° for a 5° scale length. Any cutoff
	// closer in than the window's own zero draws a circle: the arm profile
	// exp(-0.55 r) alone is still ~0.05 at r = 6 and ~0.004 at r = 10.
	float sinEdge = GALAXY_EDGE_R * scale;
	if ( along < sqrt( max( 0.0, 1.0 - sinEdge * sinEdge ) ) ) return 0.0;
	vec3 off = d - g * along;
	float x = dot( off, u ) / scale;
	float yMinor = dot( off, v ) / scale;
	float y = yMinor / prm.y;
	float r = sqrt( x * x + y * y ) + 1e-4;
	float theta = atan( y, x );
	float jitter = fbm( d * 48.0 + seed * 3.0, 3 ) - 0.5;
	float phase = prm.z * theta - prm.w * log( r ) + 1.3 * jitter;
	float arm = pow( 0.5 + 0.5 * cos( phase ), 2.0 );
	float clump = 0.45 + 0.9 * fbm( d * 110.0 + seed * 5.0, 3 );
	float armProfile = exp( - r * 0.55 ) * smoothstep( 0.3, 1.0, r );
	float disc = exp( - r * 0.9 );
	float bulge = exp( - r * r * 0.9 );
	core = exp( - r * r * 6.0 );
	// Dust lane along the major axis, stronger the more edge-on the disc.
	float edgeOn = 1.0 - prm.y;
	float lane = 1.0 - 0.75 * edgeOn * exp( - yMinor * yMinor * 40.0 ) * smoothstep( 0.35, 1.2, r );
	// The disc has an edge: an elliptical window in the same (x, y) the arms
	// live in, so the outer haze fades to exactly zero between 3.5 and 6
	// scale lengths (the bright part ends at ~2) instead of trailing off
	// exponentially until an arbitrary cutoff truncates it.
	float edge = 1.0 - smoothstep( 3.5, GALAXY_EDGE_R, r );
	return ( 0.2 * disc + 0.5 * bulge + 1.4 * armProfile * arm * clump ) * lane * edge;
}

// How much nebula survives around the galaxies: a dark pocket ~12° across
// each, so a galaxy sits in clear sky rather than dissolving into the glow.
float galaxyClearing( vec3 d ) {
	float clear = 1.0;
	for ( int i = 0; i < GALAXY_COUNT; i ++ ) {
		float ang = acos( clamp( dot( d, uGalaxyDir[ i ] ), - 1.0, 1.0 ) );
		float t = ang / ( uGalaxyParam[ i ].x * 5.0 );
		clear *= 1.0 - 0.85 * exp( - t * t * 1.5 );
	}
	return clear;
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

	// 2. swirl: twist the sampling direction about each centre
	vec3 ds = d;
	float lobes = 0.0;
	for ( int i = 0; i < SWIRL_COUNT; i ++ ) {
		vec3 c = uSwirl[ i ].xyz;
		float ang = acos( clamp( dot( d, c ), - 1.0, 1.0 ) );
		float t = ang / uSwirlRadius[ i ];
		float twist = uSwirl[ i ].w * ( 1.0 - smoothstep( 0.0, 1.0, t ) );
		ds = rotateAbout( ds, c, twist );
		lobes += exp( - t * t * 3.0 );
	}

	// 3. nebula
	float field = warpedField( ds * 3.2, seed );
	float mass = fbm( ds * 1.5 + seed * 1.3 + 5.0, 3 );
	float where = max( smoothstep( 0.5, 0.75, mass ), min( lobes, 1.0 ) * 0.9 );
	float filaments = smoothstep( 0.36, 0.8, field );
	float density = where * ( 0.1 + 1.5 * filaments * filaments ) + 0.055 * field;
	// The nadir is the darkest region; the zenith is held back so the band owns it.
	density *= mix( 0.6, 1.0, smoothstep( - 0.95, 0.05, d.y ) );
	density *= mix( 1.0, 0.55, smoothstep( 0.5, 0.95, d.y ) );
	density *= galaxyClearing( d );
	vec3 col = hue * density * uNebulaBrightness;

	// 4. the band overhead
	const vec3 bandNormal = vec3( 0.6220, 0.0, 0.7830 );
	float bandDist = dot( d, bandNormal );
	float band = exp( - bandDist * bandDist / ( 2.0 * 0.10 * 0.10 ) );
	band *= smoothstep( - 0.15, 0.55, d.y );
	float dust = 1.0 - 0.7 * smoothstep( 0.48, 0.7, fbm( ds * 9.0 + seed + 11.0, 4 ) );
	float bandTex = ( 0.3 + 0.9 * smoothstep( 0.25, 0.8, field ) ) * dust;
	col += uBandColor * band * bandTex * uBandBrightness;

	// 5. galaxies
	float glow = 0.0;
	float cores = 0.0;
	for ( int i = 0; i < GALAXY_COUNT; i ++ ) {
		float core;
		glow += galaxy( d, uGalaxyDir[ i ], uGalaxyU[ i ], uGalaxyV[ i ], uGalaxyParam[ i ], seed + float( i ), core );
		cores += core;
	}
	col += ( mix( hue, uGalaxyCoreColor, 0.3 ) * glow + uGalaxyCoreColor * cores ) * uGalaxyBrightness;

	gl_FragColor = vec4( col, 1.0 );
}
`;

/** Unit direction for a bearing (azimuth from +X toward +Z, elevation above the horizon). */
function bearingToDirection(b: SkyBearing): THREE.Vector3 {
  const az = (b.azimuthDeg * Math.PI) / 180;
  const el = (b.elevationDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
}

/**
 * The procedural nebula backdrop: a cubemap rendered ONCE (at construction,
 * and again on `regenerate`) into a `WebGLCubeRenderTarget`, then set as
 * `scene.background` by `Engine`. Per frame it costs one cubemap lookup per
 * background pixel — three draws a background cube first, depth test off, in
 * its own unfogged material — and nothing else. The shader is heavy (two
 * warp levels, four swirls, four galaxies — ~20-30 value-noise evaluations
 * per texel over 1.57M texels) but it runs once; it costs startup time, never
 * frame time. Measured at ~300 ms for a full regenerate under SwiftShader
 * (software rendering on the CPU, forced sync via a readback); on a real GPU
 * that is ~40M noise evaluations, which even an integrated part finishes in
 * tens of milliseconds.
 *
 * What it is for: navigation. In the plain clear colour every direction looks
 * the same, so after a few turns you have no idea which way the densest
 * cluster went. With a different hue at each cardinal (see
 * `SKY_CARDINAL_COLORS`), each hue's nebula whirling about a fixed centre, a
 * band overhead and four spiral galaxies at fixed bearings, the sky is a
 * compass — "navigate by the stars". It is NOT scenery: the three brightness
 * knobs keep it dark enough that the cubes and the cyan HUD stay the brightest
 * things on screen.
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
 *   fog fades to `FOG_COLOR`, which is darker than the dimmest nebula, so a
 *   fully-fogged block is a faint silhouette against the glow rather than gone
 *   — see `FOG_COLOR`.
 *
 * The render target is sRGB (`SRGBColorSpace`, unsigned bytes): the shader
 * writes linear light and the GPU applies the sRGB transfer on write, which
 * matters at this brightness — most of the sky lives in the bottom 15% of the
 * range, where a linear 8-bit target has only a handful of distinguishable
 * levels and every gradient would band. Half-float would also work at 4x the
 * bytes.
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
    const deg = (x: number) => (x * Math.PI) / 180;

    // Galaxy tangent frames: `u` along the disc's major axis, `v` along the
    // minor, both perpendicular to the bearing. Built from the world up
    // vector, then rolled by `rollDeg` about the bearing. (Degenerate only for
    // a galaxy at the exact zenith/nadir, which none is.)
    const galaxyDir = SKY_GALAXIES.map(bearingToDirection);
    const galaxyU: THREE.Vector3[] = [];
    const galaxyV: THREE.Vector3[] = [];
    SKY_GALAXIES.forEach((g, i) => {
      const dir = galaxyDir[i];
      const east = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
      const north = new THREE.Vector3().crossVectors(dir, east).normalize();
      const roll = deg(g.rollDeg);
      galaxyU.push(east.clone().multiplyScalar(Math.cos(roll)).addScaledVector(north, Math.sin(roll)));
      galaxyV.push(east.clone().multiplyScalar(-Math.sin(roll)).addScaledVector(north, Math.cos(roll)));
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSeed: { value: 0 },
        uNebulaBrightness: { value: SKY_NEBULA_BRIGHTNESS },
        uBandBrightness: { value: SKY_BAND_BRIGHTNESS },
        uGalaxyBrightness: { value: SKY_GALAXY_BRIGHTNESS },
        uCardinal: { value: SKY_CARDINAL_COLORS.map(toLinear) },
        uBandColor: { value: toLinear(SKY_BAND_COLOR) },
        uGalaxyCoreColor: { value: toLinear(SKY_GALAXY_CORE_COLOR) },
        uSwirl: {
          value: SKY_SWIRLS.map((s) => {
            const c = bearingToDirection(s);
            return new THREE.Vector4(c.x, c.y, c.z, s.twistRad);
          }),
        },
        uSwirlRadius: { value: SKY_SWIRLS.map((s) => deg(s.radiusDeg)) },
        uGalaxyDir: { value: galaxyDir },
        uGalaxyU: { value: galaxyU },
        uGalaxyV: { value: galaxyV },
        uGalaxyParam: {
          value: SKY_GALAXIES.map((g) => new THREE.Vector4(deg(g.scaleDeg), g.axisRatio, g.arms, g.winding)),
        },
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
