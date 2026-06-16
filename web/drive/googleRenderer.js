// googleRenderer.js — the "photoreal" engine: Google Photorealistic 3D Tiles
// streamed into a normal Three.js scene.
//
// This is one of the two interchangeable renderers. Its job:
//   - own the WebGLRenderer / scene / camera that draws the canvas (#c)
//   - stream Google's 3D tiles around the camera
//   - answer sampleHeight(x,z) by raycasting those tiles (so the car sits on roads)
//   - run a chase camera each frame
//
// The shared simulation (sim.js) drives the car; this module only renders it and
// reports ground heights. The Mapbox engine implements the same small surface
// (sampleHeight + show/hide), so the app can flip between them.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import * as cfg from './config.js';

const deg2rad = THREE.MathUtils.degToRad;
const UP = new THREE.Vector3(0, 1, 0);

export function createGoogleRenderer({ canvas, googleKey, spawn, loadEl }) {
  // ---- renderer / scene / camera ----
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,   // mandatory at planet scale to avoid z-fighting
  });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const SKY = 0xaecadf;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 2500, 11000);   // hide far tile LOD swaps

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 15000);
  camera.position.set(40, 5000, 40);
  camera.lookAt(0, 0, 0);

  // OrbitControls is a debug/free-look mode; the chase cam drives normally.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false;

  // ---- lighting ----
  // Google tiles are photo-textured (daylight baked in), so keep light gentle and
  // neutral; the directional light mostly exists to shape the car.
  scene.add(new THREE.AmbientLight(0xffffff, 1.25));
  const sun = new THREE.DirectionalLight(0xfff4e6, 0.7);
  sun.position.set(-60, 90, 40);
  scene.add(sun);

  // ---- the 3D tiles ----
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: googleKey, autoRefreshToken: true }));
  // ReorientationPlugin re-roots the globe so our spawn point sits at the origin,
  // matching the local frame in geo.js.
  tiles.registerPlugin(new ReorientationPlugin({ lat: deg2rad(spawn.lat), lon: deg2rad(spawn.lon), height: 0 }));
  tiles.errorTarget = cfg.GOOGLE_TILE_ERROR_TARGET;
  tiles.lruCache.minSize = cfg.GOOGLE_TILE_CACHE_MIN_SIZE;
  tiles.lruCache.maxSize = cfg.GOOGLE_TILE_CACHE_MAX_SIZE;
  tiles.lruCache.maxBytesSize = cfg.GOOGLE_TILE_CACHE_MAX_BYTES;
  tiles.downloadQueue.maxJobs = cfg.GOOGLE_TILE_DOWNLOAD_JOBS;
  tiles.setCamera(camera);
  scene.add(tiles.group);

  // sharpen building textures at grazing angles
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  function sharpenModel(model) {
    model.traverse(c => {
      if (c.isMesh && c.material && c.material.map) c.material.map.anisotropy = maxAnisotropy;
    });
  }

  let tilesReady = false;
  tiles.addEventListener('load-tileset', () => { tilesReady = true; });
  tiles.addEventListener('load-model', e => sharpenModel(e.scene));
  tiles.addEventListener('load-error', e => console.warn('tiles load-error:', e.error || e));

  // If nothing has rendered after a while it's almost always a key/API problem.
  setTimeout(() => {
    if (!tilesReady && loadEl && loadEl.style.opacity !== '0') {
      loadEl.innerHTML = 'Still loading… check the Map Tiles API is enabled on your Google key and its domain restriction allows this site.<br><small style="opacity:.7">Clear the key: run <code>localStorage.removeItem("GOOGLE_MAPS_KEY")</code> and reload.</small>';
    }
  }, 15000);

  // ---- attribution (Google's ToS requires it stay visible) ----
  const attribEl = document.getElementById('attrib');
  function updateAttribution() {
    if (!attribEl || !tiles.getAttributions) return;
    let html = '';
    for (const a of tiles.getAttributions()) {
      if (!a || a.value == null) continue;
      html += a.type === 'image' ? `<img src="${a.value}" alt="">` : `<span>${a.value}</span>`;
    }
    if (html !== attribEl.dataset.h) { attribEl.innerHTML = html; attribEl.dataset.h = html; }
  }

  // ---- ground probe: raycast straight down through the tiles ----
  const _rc = new THREE.Raycaster();
  _rc.firstHitOnly = true;
  const _down = new THREE.Vector3(0, -1, 0);
  const _from = new THREE.Vector3();
  const _nmat = new THREE.Matrix3();
  const _tmpN = new THREE.Vector3();

  function faceNormal(hit) {
    if (hit.face) {
      _nmat.getNormalMatrix(hit.object.matrixWorld);
      return _tmpN.copy(hit.face.normal).applyMatrix3(_nmat).normalize();
    }
    return UP;
  }

  // sampleHeight(x,z) -> { y, normal } | null. Returns null until tiles stream in.
  function sampleHeight(x, z) {
    _rc.set(_from.set(x, 9000, z), _down);
    _rc.far = 10000;
    const hits = _rc.intersectObject(tiles.group, true);
    if (!hits.length) return null;
    return { y: hits[0].point.y, normal: faceNormal(hits[0]) };
  }

  // ---- chase camera ----
  const _camGoal = new THREE.Vector3(), _look = new THREE.Vector3(), _camFwd = new THREE.Vector3();
  function updateChase(dt, sim) {
    const isPlane = sim.vehicle === 'plane';
    const back = isPlane ? cfg.CHASE_BACK * 0.5 : cfg.CHASE_BACK;
    const up = isPlane ? cfg.CHASE_UP * 0.5 : cfg.CHASE_UP;
    _camFwd.set(Math.sin(sim.heading), 0, Math.cos(sim.heading)).normalize();
    _camGoal.copy(sim.carPos).addScaledVector(_camFwd, -back).addScaledVector(UP, up);

    if (isPlane) {
      camera.position.copy(_camGoal);   // rigid follow so it doesn't lag at high speed
    } else {
      const k = 1 - Math.exp(-cfg.CHASE_LERP * dt);
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, _camGoal.x, k);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, _camGoal.z, k);
      camera.position.y = _camGoal.y;
    }
    _look.copy(sim.carPos).addScaledVector(UP, cfg.LOOK_H);
    camera.lookAt(_look);
  }

  // ---- per-frame render (only called while Google is the active engine) ----
  function render(dt, sim) {
    if (sim.driveReady) {
      if (!controls.enabled) updateChase(dt, sim);
    } else if (controls.enabled) {
      controls.update();
    }
    camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    updateAttribution();
    renderer.render(scene, camera);
  }

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  return {
    renderer, scene, camera,
    sampleHeight,
    render,
    resize,
    show: () => { renderer.domElement.style.display = 'block'; },
    hide: () => { renderer.domElement.style.display = 'none'; },
    toggleFreeLook: () => { controls.enabled = !controls.enabled; },
    get tilesReady() { return tilesReady; },
  };
}
