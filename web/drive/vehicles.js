// vehicles.js — loading and dressing the two drivable models.
//
// We have two vehicles: "Eleanor" (the car) and the SR-71 (the plane). Each is a
// THREE.Group that the physics moves around. Crucially these groups are SHARED:
//   - the Google renderer adds them straight into its scene, and
//   - the Mapbox renderer clones the car into its own custom layer.
// So this module just builds the groups + loads the GLBs; the renderers decide
// how to display them.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import eleanorGlb from '../eleanor.glb?url';
import sr71Glb from '../sr71.glb?url';

// GLBs are DRACO-compressed, so every loader needs the decoder wired up.
function makeGltfLoader() {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  loader.setDRACOLoader(draco);
  return loader;
}

// Re-centre a freshly loaded model so its base sits on y=0 and it's centred in XZ.
function groundModel(root) {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const ctr = box.getCenter(new THREE.Vector3());
  root.position.x -= ctr.x;
  root.position.z -= ctr.z;
  root.position.y -= box.min.y;
}

// Paint the car: two black racing stripes down the bonnet/roof over a silver body.
// We bake the stripe pattern into per-vertex colours so it needs no extra texture.
function applyStripes(mesh, bodyMat, INNER, OUTER) {
  const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
  const mw = mesh.matrixWorld;
  const nmat = new THREE.Matrix3().getNormalMatrix(mw);
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const silver = new THREE.Color(0.34, 0.34, 0.37), black = new THREE.Color(0.012, 0.012, 0.012);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mw);
    n.fromBufferAttribute(nor, i).applyMatrix3(nmat).normalize();
    const ax = Math.abs(v.x);
    // black where we're near the centre-line (the stripe) and facing upward
    const c = (ax > INNER && ax < OUTER && n.y > 0.35) ? black : silver;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  mesh.material = bodyMat;
}

// A neutral grey studio environment so the car's metallic paint reflects greys
// instead of picking up the sky's blue tint. Returns a PMREM-processed texture.
export function makeGreyEnv(renderer) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  const grd = x.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.00, '#b8bcc2'); grd.addColorStop(0.50, '#5e636b');
  grd.addColorStop(0.52, '#3a3e45'); grd.addColorStop(1.00, '#15171b');
  x.fillStyle = grd; x.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  return pmrem.fromEquirectangular(tex).texture;
}

// createVehicles(renderer) builds both groups and kicks off async GLB loading.
// `renderer` is only needed to bake the reflection environment for the car paint.
// Returns the shared groups plus a ready() check used to gate the spawn.
export function createVehicles(renderer) {
  const greyEnvTex = makeGreyEnv(renderer);
  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.85, roughness: 0.3,
    envMap: greyEnvTex, envMapIntensity: 1.0,
  });

  // --- car ---
  const carGroup = new THREE.Group();
  const wheels = [];               // the four wheel pivots, spun to match speed
  let carLoaded = false;
  const STRIPE_INNER = 0.05, STRIPE_OUTER = 0.27;
  makeGltfLoader().load(eleanorGlb, (gltf) => {
    const root = gltf.scene;
    carGroup.add(root);
    groundModel(root);
    root.traverse(o => {
      if (o.isMesh) {
        o.frustumCulled = false;
        if (o.material && o.material.name === 'carpaint') applyStripes(o, bodyMat, STRIPE_INNER, STRIPE_OUTER);
      }
      if (o.name && o.name.startsWith('Wheel_') && o.name.endsWith('_ctrl')) wheels.push(o);
    });
    carLoaded = true;
  }, undefined, (err) => {
    const loadText = document.getElementById('loadText') || document.getElementById('load');
    if (loadText) loadText.textContent = 'Failed to load eleanor.glb';
    console.error(err);
  });

  // --- plane ---
  const planeGroup = new THREE.Group();
  planeGroup.visible = false;
  let planeLoaded = false;
  makeGltfLoader().load(sr71Glb, (gltf) => {
    const root = gltf.scene;
    root.rotation.y = -Math.PI / 2;   // the model points sideways; face it forward
    planeGroup.add(root);
    groundModel(root);
    root.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    planeLoaded = true;
  }, undefined, (err) => console.error(err));

  return {
    carGroup,
    planeGroup,
    wheels,
    ready: (vehicle = 'car') => vehicle === 'plane' ? planeLoaded : carLoaded,
  };
}
