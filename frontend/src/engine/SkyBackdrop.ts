import * as THREE from "three";

/** One sky lookup per pixel, without cube faces crossing the camera's clip plane.
 * The unit background cube produced flat polygon seams on the tested WebGL
 * renderer. Reconstructing rays on one fullscreen triangle avoids that clipping
 * path and replaces (rather than adds to) Three's background draw. */
export class SkyBackdrop {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor(texture: THREE.CubeTexture) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      -1, -1, 0, 3, -1, 0, -1, 3, 0,
    ], 3));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        sky: { value: texture },
        inverseProjection: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
      },
      vertexShader: /* glsl */ `
        uniform mat4 inverseProjection;
        uniform mat4 cameraWorld;
        varying vec3 skyDirection;
        void main() {
          vec4 ray = inverseProjection * vec4(position.xy, 1.0, 1.0);
          skyDirection = mat3(cameraWorld) * ray.xyz;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform samplerCube sky;
        varying vec3 skyDirection;
        void main() {
          gl_FragColor = textureCube(sky, skyDirection);
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "Sky backdrop";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1_000_000;
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => this.updateCamera(camera);
  }

  updateCamera(camera: THREE.Camera): void {
    this.mesh.material.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
    this.mesh.material.uniforms.cameraWorld.value.copy(camera.matrixWorld);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    // The cubemap remains owned by NebulaSky.
  }
}
