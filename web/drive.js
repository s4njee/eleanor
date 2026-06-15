import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';

// ---- config -------------------------------------------------------------
// Default drive: down Manhattan (Times Square -> Financial District) through the
// skyscrapers, rendered with Google Photorealistic 3D Tiles (real textured city).
// Alternatives — swap START/END:
//   San Francisco    : {lat:37.76928,lon:-122.48618} -> {lat:37.79553,lon:-122.39379}
//   Chicago Loop     : {lat:41.8855, lon:-87.6210}   -> {lat:41.8676, lon:-87.6075}
//   Las Vegas Strip  : {lat:36.1290, lon:-115.1665}  -> {lat:36.1003, lon:-115.1729}
const START = { lat: 40.75800, lon: -73.98551 };   // Times Square
const END   = { lat: 40.70726, lon: -74.00874 };   // Financial District (Wall St)
const ROUTE_LATERAL_OFFSET = 0;        // metres; nudge onto the visible lane if the OSM centreline is off

// car / driving (reused tuning from index.html, gentler accel for real roads)
const WHEEL_RADIUS = 0.325, SPIN_SIGN = -1;
const MAX_SPEED = 30, ACCEL = 13, DECEL = 22;
const CHASE_BACK = 7.5, CHASE_UP = 3.2, LOOK_H = 1.3, CHASE_LERP = 3.2;
const BANK_GAIN = 0.004, BANK_MAX = 0.22;

// Offline fallback: real OSRM result for the default Manhattan route (decimated) so
// the page still drives if router.project-osrm.org is rate-limited / unreachable.
const FALLBACK_ROUTE = [[-73.985506,40.758002],[-73.985684,40.758025],[-73.986728,40.758462],[-73.98834,40.759223],[-73.987929,40.759787],[-73.987252,40.759501],[-73.985492,40.758767],[-73.98508,40.758597],[-73.982703,40.757579],[-73.982124,40.757335],[-73.979023,40.756037],[-73.978404,40.755779],[-73.977408,40.755362],[-73.976593,40.755022],[-73.976285,40.754888],[-73.975925,40.754732],[-73.974627,40.754179],[-73.97419,40.753994],[-73.97273,40.753385],[-73.971715,40.752958],[-73.970388,40.752315],[-73.97084,40.751699],[-73.971263,40.751122],[-73.971582,40.750677],[-73.971751,40.750441],[-73.972131,40.749927],[-73.972008,40.749748],[-73.970054,40.74892],[-73.969717,40.748728],[-73.969596,40.748641],[-73.968664,40.74824],[-73.968539,40.748156],[-73.968486,40.74807],[-73.968485,40.747989],[-73.968532,40.747899],[-73.968985,40.747281],[-73.969426,40.746756],[-73.970923,40.745191],[-73.971258,40.744685],[-73.971241,40.744513],[-73.97132,40.744347],[-73.971864,40.743525],[-73.972226,40.743081],[-73.972554,40.742527],[-73.972741,40.741974],[-73.972904,40.740672],[-73.973155,40.739517],[-73.973433,40.738873],[-73.973816,40.738339],[-73.974629,40.737221],[-73.9748,40.73695],[-73.974945,40.736641],[-73.975031,40.736331],[-73.97506,40.736089],[-73.97505,40.73578],[-73.974974,40.73541],[-73.973982,40.73159],[-73.973828,40.731279],[-73.973603,40.730971],[-73.973229,40.730618],[-73.972539,40.730051],[-73.972279,40.729796],[-73.972018,40.729421],[-73.971875,40.729114],[-73.971792,40.728795],[-73.971765,40.728481],[-73.971821,40.727949],[-73.971958,40.72697],[-73.972027,40.726642],[-73.97213,40.726334],[-73.972318,40.725937],[-73.972651,40.72534],[-73.973019,40.724756],[-73.973389,40.724165],[-73.974252,40.722792],[-73.974405,40.72249],[-73.974531,40.722169],[-73.974614,40.72185],[-73.974715,40.721087],[-73.975043,40.71849],[-73.975183,40.717859],[-73.97538,40.71723],[-73.975638,40.716611],[-73.977759,40.712523],[-73.977963,40.71219],[-73.978201,40.711928],[-73.978451,40.71171],[-73.97879,40.711474],[-73.979136,40.711289],[-73.979504,40.71114],[-73.979894,40.711026],[-73.980304,40.710946],[-73.980726,40.710904],[-73.984225,40.71066],[-73.984995,40.71059],[-73.989528,40.710064],[-73.993228,40.709517],[-73.994054,40.709414],[-73.996849,40.709027],[-73.997732,40.708877],[-73.998052,40.708785],[-73.998807,40.708555],[-73.999018,40.7085],[-73.999235,40.708488],[-73.999515,40.708577],[-73.999653,40.708671],[-73.999742,40.708781],[-73.99997,40.709119],[-74.000138,40.709295],[-74.00035,40.709477],[-74.000645,40.709848],[-74.000939,40.710091],[-74.001211,40.710056],[-74.001449,40.709733],[-74.001619,40.709524],[-74.001809,40.709374],[-74.002452,40.708887],[-74.002836,40.708573],[-74.003293,40.708197],[-74.003503,40.708007],[-74.004074,40.707443],[-74.004936,40.706901],[-74.005694,40.706381],[-74.006088,40.706103],[-74.006753,40.705634],[-74.007411,40.706036],[-74.007988,40.706355],[-74.008954,40.706928],[-74.008976,40.706995],[-74.008739,40.707256]];

const deg2rad = THREE.MathUtils.degToRad;
const loadEl = document.getElementById('load');
const speedEl = document.getElementById('speed');

// ---- Google Maps API key gate -------------------------------------------
const ENV_KEY = import.meta.env ? import.meta.env.VITE_GOOGLE_MAPS_KEY : undefined;
const GOOGLE_KEY = ENV_KEY || localStorage.getItem('GOOGLE_MAPS_KEY') || '';
if (!GOOGLE_KEY) {
  loadEl.style.display = 'none';
  const t = document.getElementById('token');
  t.style.display = 'flex';
  document.getElementById('tokenSave').onclick = () => {
    const v = document.getElementById('tokenInput').value.trim();
    if (v) { localStorage.setItem('GOOGLE_MAPS_KEY', v); location.reload(); }
  };
  document.getElementById('tokenInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('tokenSave').click();
  });
} else {
  main();
}

function main() {
  // ---- renderer / scene / camera ----------------------------------------
  const renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('c'),
    antialias: true,
    logarithmicDepthBuffer: true   // mandatory at planet scale
  });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const SKY = 0xaecadf;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 2500, 11000);   // soften far LOD swaps

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 2e7);
  camera.position.set(40, 35, 40);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false;   // chase cam drives once ready; 'o' toggles free-look

  // ---- lighting ---------------------------------------------------------
  // Google tiles are photo-textured (baked daylight), so keep it gentle/neutral;
  // the directional light is mostly to shape the car.
  scene.add(new THREE.AmbientLight(0xffffff, 1.25));
  const sun = new THREE.DirectionalLight(0xfff4e6, 0.7);
  sun.position.set(-60, 90, 40);
  scene.add(sun);

  // neutral grey env so the car paint reflects greys, not the sky tint
  const greyEnvTex = makeGreyEnv(renderer);

  // ---- Google Photorealistic 3D Tiles -----------------------------------
  // One global photoreal tileset (terrain + textured buildings + trees), reoriented
  // to the route start. The car raycasts against this for its height.
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: GOOGLE_KEY, autoRefreshToken: true }));
  tiles.registerPlugin(new ReorientationPlugin({ lat: deg2rad(START.lat), lon: deg2rad(START.lon), height: 0 }));
  tiles.setCamera(camera);
  scene.add(tiles.group);

  // Google's ToS requires the on-screen data attribution to stay visible.
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

  let tilesReady = false;
  tiles.addEventListener('load-tileset', () => { tilesReady = true; });
  tiles.addEventListener('load-error', e => console.warn('tiles load-error:', e.error || e));

  // surface this if nothing renders (usually a key / API / restriction problem)
  setTimeout(() => {
    if (!tilesReady && loadEl.style.opacity !== '0') {
      loadEl.innerHTML = 'Still loading… check the Map Tiles API is enabled on your Google key and its domain restriction allows this site.<br><small style="opacity:.7">Clear the key: run <code>localStorage.removeItem("GOOGLE_MAPS_KEY")</code> and reload.</small>';
    }
  }, 15000);

  // ---- geo -> local scene frame -----------------------------------------
  // tiles.group.matrixWorld maps ECEF -> reoriented local metres (start at origin, Y up).
  const _ecef = new THREE.Vector3();
  function geoToLocal(latDeg, lonDeg, height, target) {
    WGS84_ELLIPSOID.getCartographicToPosition(deg2rad(latDeg), deg2rad(lonDeg), height || 0, _ecef);
    return target.copy(_ecef).applyMatrix4(tiles.group.matrixWorld);
  }

  // ---- car --------------------------------------------------------------
  const carGroup = new THREE.Group();
  scene.add(carGroup);
  const wheels = [];
  let carLoaded = false;
  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.85, roughness: 0.3,
    envMap: greyEnvTex, envMapIntensity: 1.0
  });
  loadCar(carGroup, wheels, bodyMat, () => { carLoaded = true; });

  // ---- route ------------------------------------------------------------
  let routeCoords = null, routeCurve = null, routeLength = 0;
  const startLocal = new THREE.Vector3();
  let routeReady = false, driveReady = false;
  let routeLine = null;

  getRoute(START, END).then(c => { routeCoords = c; });

  function tryBuildRoute() {
    if (routeReady || !routeCoords || !tilesReady) return;
    tiles.group.updateMatrixWorld(true);
    geoToLocal(START.lat, START.lon, 0, startLocal);
    if (!isFinite(startLocal.length()) || startLocal.length() > 1e5) return;  // matrixWorld not settled
    const pts = routeCoords.map(([lon, lat]) => { const v = geoToLocal(lat, lon, 0, new THREE.Vector3()); v.y = 0; return v; });
    routeCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    routeLength = routeCurve.getLength();
    routeReady = true;
    buildRouteLine(pts);
  }

  function buildRouteLine(pts) {
    const dense = routeCurve.getSpacedPoints(Math.max(200, pts.length * 2));
    const g = new THREE.BufferGeometry().setFromPoints(dense);
    routeLine = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: 0xffb000, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false
    }));
    routeLine.renderOrder = 2;
    routeLine.frustumCulled = false;
    scene.add(routeLine);
  }

  // raycast the route line onto the terrain a few points per frame (drapes as tiles load)
  let drapeCursor = 0;
  function drapeRouteLine() {
    if (!routeLine) return;
    const pos = routeLine.geometry.attributes.position;
    for (let n = 0; n < 24; n++) {
      const i = drapeCursor % pos.count;
      drapeCursor++;
      const hit = sampleGround(pos.getX(i), pos.getZ(i));
      if (hit && Math.abs(hit.point.y) < 2000) pos.setY(i, hit.point.y + 0.4);
    }
    pos.needsUpdate = true;
  }

  // ---- surface raycast --------------------------------------------------
  const _rc = new THREE.Raycaster();
  _rc.firstHitOnly = true;
  const _down = new THREE.Vector3(0, -1, 0);
  const _from = new THREE.Vector3();
  const _nmat = new THREE.Matrix3();
  // Cast within a sane vertical window (≈[-1000, 3000] m around the start) so we never
  // latch onto coarse low-LOD tiles, whose surfaces can sit tens of km below the tangent
  // plane due to earth curvature. Real city terrain lives near 0; garbage is excluded.
  function sampleGround(x, z) {
    _rc.set(_from.set(x, 3000, z), _down);
    _rc.far = 4000;
    const hits = _rc.intersectObject(tiles.group, true);
    return hits.length ? hits[0] : null;
  }

  // ---- driving state ----------------------------------------------------
  let driving = false, speed = 0, distance = 0;
  let smoothY = 0;
  const smoothNormal = new THREE.Vector3(0, 1, 0);
  const UP = new THREE.Vector3(0, 1, 0);
  addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); driving = true; }
    if (e.code === 'KeyO') { controls.enabled = !controls.enabled; }
    if (e.code === 'KeyR') { distance = 0; speed = 0; }   // restart route
  });
  addEventListener('keyup', e => { if (e.code === 'Space') { e.preventDefault(); driving = false; } });
  addEventListener('blur', () => { driving = false; });

  function tryStart() {
    if (driveReady || !routeReady || !carLoaded) return;
    const hit = sampleGround(startLocal.x, startLocal.z);
    if (!hit) return;   // wait until in-window terrain has streamed in near the start
    smoothY = hit.point.y;
    smoothNormal.copy(faceNormal(hit));
    placeCar(0);
    driveReady = true;
    loadEl.style.opacity = 0;
    setTimeout(() => (loadEl.style.display = 'none'), 600);
  }

  // ---- per-frame car placement ------------------------------------------
  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _right = new THREE.Vector3();
  const _fwd = new THREE.Vector3(), _basis = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _zAxis = new THREE.Vector3(0, 0, 1);

  function placeCar(u) {
    routeCurve.getPointAt(u, _p);
    routeCurve.getTangentAt(u, _t); _t.y = 0; _t.normalize();
    if (ROUTE_LATERAL_OFFSET) { _right.crossVectors(_t, UP).normalize(); _p.addScaledVector(_right, ROUTE_LATERAL_OFFSET); }
    const hit = sampleGround(_p.x, _p.z);
    if (hit) {   // the ray window already filters coarse km-scale outliers; just smooth
      smoothY = THREE.MathUtils.lerp(smoothY, hit.point.y, 0.25);
      smoothNormal.lerp(faceNormal(hit), 0.18).normalize();
    }
    carGroup.position.set(_p.x, smoothY + 0.05, _p.z);
    orientCar(_t, smoothNormal, bankAt(u));
  }

  function orientCar(forward, up, bank) {
    _right.crossVectors(forward, up).normalize();  // right = forward x up (right-handed)
    _fwd.crossVectors(up, _right).normalize();     // forward, re-orthogonalised to the surface slope
    _basis.makeBasis(_right, up, _fwd.negate());   // car nose is -Z, so local +Z = -forward
    _q.setFromRotationMatrix(_basis);
    _q.multiply(_qBank.setFromAxisAngle(_zAxis, bank));   // roll about car local Z
    carGroup.quaternion.slerp(_q, 0.2);
  }
  const _qBank = new THREE.Quaternion();

  function bankAt(u) {
    const du = 0.0015;
    routeCurve.getTangentAt(Math.max(0, u - du), _ta); _ta.y = 0; _ta.normalize();
    routeCurve.getTangentAt(Math.min(1, u + du), _tb); _tb.y = 0; _tb.normalize();
    const turn = Math.sign(_ta.x * _tb.z - _ta.z * _tb.x);   // signed
    const k = _ta.angleTo(_tb) / Math.max(2 * du * routeLength, 1e-3);
    return THREE.MathUtils.clamp(-turn * k * speed * speed * BANK_GAIN, -BANK_MAX, BANK_MAX);
  }

  function faceNormal(hit) {
    if (hit.face) {
      _nmat.getNormalMatrix(hit.object.matrixWorld);
      return _tmpN.copy(hit.face.normal).applyMatrix3(_nmat).normalize();
    }
    return UP;
  }
  const _tmpN = new THREE.Vector3();

  // ---- chase cam --------------------------------------------------------
  const _camGoal = new THREE.Vector3(), _look = new THREE.Vector3(), _camFwd = new THREE.Vector3();
  function updateChase(dt) {
    const u = routeLength > 0 ? distance / routeLength : 0;
    routeCurve.getTangentAt(u, _camFwd); _camFwd.y = 0; _camFwd.normalize();
    _camGoal.copy(carGroup.position).addScaledVector(_camFwd, -CHASE_BACK).addScaledVector(UP, CHASE_UP);
    const k = 1 - Math.exp(-CHASE_LERP * dt);
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, _camGoal.x, k);
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, _camGoal.z, k);
    camera.position.y = _camGoal.y;   // track height directly so the cam never lags/sinks through terrain
    _look.copy(carGroup.position).addScaledVector(UP, LOOK_H);
    camera.lookAt(_look);
  }

  // ---- loop -------------------------------------------------------------
  const clock = new THREE.Clock();
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);

    camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    updateAttribution();

    tryBuildRoute();
    if (routeReady) drapeRouteLine();
    tryStart();

    if (driveReady) {
      speed += (driving ? ACCEL : -DECEL) * dt;
      speed = Math.max(0, Math.min(MAX_SPEED, speed));
      distance = Math.min(distance + speed * dt, routeLength);
      const u = routeLength > 0 ? distance / routeLength : 0;
      placeCar(u);
      const droll = SPIN_SIGN * (speed * dt) / WHEEL_RADIUS;
      for (const w of wheels) w.rotation.x += droll;
      updateChase(dt);
      const arrived = distance >= routeLength - 0.5;
      speedEl.textContent = arrived ? 'arrived · press R' : Math.round(speed * 3.6) + ' km/h';
    } else if (controls.enabled) {
      controls.update();
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ---- helpers (module scope) ---------------------------------------------
async function getRoute(a, b) {
  const key = `osrm:${a.lon},${a.lat};${b.lon},${b.lat}`;
  const cached = localStorage.getItem(key);
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const json = await res.json();
    const coords = json.routes[0].geometry.coordinates;
    localStorage.setItem(key, JSON.stringify(coords));
    return coords;
  } catch (e) {
    console.warn('OSRM unavailable — using embedded fallback route.', e);
    return FALLBACK_ROUTE;
  }
}

function loadCar(carGroup, wheels, bodyMat, done) {
  const STRIPE_INNER = 0.05, STRIPE_OUTER = 0.27;
  const gltfLoader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  gltfLoader.setDRACOLoader(draco);
  gltfLoader.load('eleanor.glb', (gltf) => {
    const root = gltf.scene;
    carGroup.add(root);
    carGroup.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    const ctr = box.getCenter(new THREE.Vector3());
    root.position.x -= ctr.x; root.position.z -= ctr.z; root.position.y -= box.min.y;
    carGroup.updateWorldMatrix(true, true);
    root.traverse(o => {
      if (o.isMesh) {
        o.frustumCulled = false;
        if (o.material && o.material.name === 'carpaint') applyStripes(o, bodyMat, STRIPE_INNER, STRIPE_OUTER);
      }
      if (o.name && o.name.startsWith('Wheel_') && o.name.endsWith('_ctrl')) wheels.push(o);
    });
    done();
  }, undefined, (err) => {
    document.getElementById('load').textContent = 'Failed to load eleanor.glb';
    console.error(err);
  });
}

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
    const c = (ax > INNER && ax < OUTER && n.y > 0.35) ? black : silver;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  mesh.material = bodyMat;
}

function makeGreyEnv(renderer) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  const grd = x.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0.00, '#b8bcc2'); grd.addColorStop(0.50, '#5e636b');
  grd.addColorStop(0.52, '#3a3e45'); grd.addColorStop(1.00, '#15171b');
  x.fillStyle = grd; x.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  return pmrem.fromEquirectangular(tex).texture;
}
