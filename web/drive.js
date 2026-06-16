import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer/three';
import { ReorientationPlugin } from '3d-tiles-renderer/three/plugins';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import eleanorGlb from './eleanor.glb?url';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

// ---- dynamic config via URL ---------------------------------------------
const params = new URLSearchParams(location.search);
const spawnLat = parseFloat(params.get('lat')) || 40.75800;
const spawnLon = parseFloat(params.get('lon')) || -73.98551;
const spawnName = params.get('name') || 'Times Square';
const INITIAL_ENGINE = params.get('engine') === 'mapbox' ? 'mapbox' : 'google';

const SPAWN = { lat: spawnLat, lon: spawnLon };
let SPAWN_HEADING = Math.PI;   // radians, 0 = +Z, PI = -Z (south)

// car / driving tuning
const WHEEL_RADIUS = 0.325, SPIN_SIGN = -1;
const MAX_SPEED = 30;           // m/s (~108 km/h)
const REVERSE_MAX = 5;          // m/s
const ACCEL = 13;               // m/s²
const BRAKE_DECEL = 28;         // m/s² (braking is stronger than coast)
const COAST_DECEL = 4;          // m/s² (no input = gentle coast-down)
const HANDBRAKE_DECEL = 45;     // m/s²

// steering (bicycle model)
const WHEELBASE = 2.6;          // metres (front-to-rear axle)
const MAX_STEER = 0.6;          // radians (~35°)
const STEER_SPEED = 2.5;        // rad/s (how fast the wheel turns)
const STEER_RETURN = 4.0;       // rad/s (how fast it centres when released)

// chase camera
const CHASE_BACK = 7.5, CHASE_UP = 3.2, LOOK_H = 1.3, CHASE_LERP = 3.2;

// visual
const BANK_GAIN = 0.004, BANK_MAX = 0.22;

// ---- OSM road constraint ------------------------------------------------
const ROAD_HALF_WIDTH = 6;      // metres — hard wall at road edge

// Calculate a ~3.3x3.3 km bounding box around spawn for road fetching
// (0.015 degrees is roughly 1.6km from center)
const bboxHalf = 0.015;
const ROAD_BBOX = `${(SPAWN.lat - bboxHalf).toFixed(5)},${(SPAWN.lon - bboxHalf).toFixed(5)},${(SPAWN.lat + bboxHalf).toFixed(5)},${(SPAWN.lon + bboxHalf).toFixed(5)}`;
const ROAD_TYPES = 'motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|living_street';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const ROAD_GRID_CELL = 20;      // metres per grid cell

const deg2rad = THREE.MathUtils.degToRad;
const loadEl = document.getElementById('load');
const speedEl = document.getElementById('speed');

// ---- Search UI Logic ----------------------------------------------------
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
if (searchForm && searchInput) {
  if (spawnName !== 'Times Square') searchInput.placeholder = `Driving in ${spawnName}`;
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    const btn = searchForm.querySelector('button');
    btn.textContent = '...';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
      const data = await res.json();
      if (data && data.length > 0) {
        const loc = data[0];
        const engParam = window.activeEngine === 'mapbox' ? '&engine=mapbox' : '';
        window.location.href = `?lat=${loc.lat}&lon=${loc.lon}&name=${encodeURIComponent(q)}${engParam}`;
      } else {
        alert("City not found.");
        btn.textContent = 'Go';
      }
    } catch (err) {
      alert("Search failed.");
      btn.textContent = 'Go';
    }
  });
}

// ---- Google Maps API key gate -------------------------------------------
const ENV_KEY = import.meta.env ? import.meta.env.VITE_GOOGLE_MAPS_KEY : undefined;
const GOOGLE_KEY = ENV_KEY || localStorage.getItem('GOOGLE_MAPS_KEY') || '';
const MAPBOX_TOKEN = (import.meta.env ? import.meta.env.VITE_MAPBOX_TOKEN : undefined) || localStorage.getItem('MAPBOX_TOKEN') || '';
if (!GOOGLE_KEY && INITIAL_ENGINE !== 'mapbox') {
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

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 15000);
  camera.position.set(40, 5000, 40);
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
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: GOOGLE_KEY, autoRefreshToken: true }));
  tiles.registerPlugin(new ReorientationPlugin({ lat: deg2rad(SPAWN.lat), lon: deg2rad(SPAWN.lon), height: 0 }));
  tiles.errorTarget = 3.5;       // Sweet spot: crisp geometry without saturating network/API limits
  tiles.lruCache.maxSize = 5000; // Massively increased to prevent LRU thrashing
  tiles.lruCache.minSize = 4000;
  tiles.downloadQueue.maxJobs = 10; // Reduced from 20 to prevent Google API from throttling requests
  tiles.setCamera(camera);
  scene.add(tiles.group);

  // Enable Anisotropic Filtering on all loaded building textures to drastically reduce side-blur at oblique angles
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  tiles.onLoadModel = (scene) => {
    scene.traverse(c => {
      if (c.isMesh && c.material && c.material.map) {
        c.material.map.anisotropy = maxAnisotropy;
      }
    });
  };

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
  const _ecef = new THREE.Vector3();
  const _baseFrame = new THREE.Matrix4();
  const _baseFrameInverse = new THREE.Matrix4();
  WGS84_ELLIPSOID.getEastNorthUpFrame(deg2rad(SPAWN.lat), deg2rad(SPAWN.lon), 0, _baseFrame);
  _baseFrameInverse.copy(_baseFrame).invert();

  function geoToLocal(latDeg, lonDeg, height, target) {
    WGS84_ELLIPSOID.getCartographicToPosition(deg2rad(latDeg), deg2rad(lonDeg), height || 0, _ecef);
    target.copy(_ecef).applyMatrix4(_baseFrameInverse);
    // target is in ENU: x=East, y=North, z=Up.
    // Three.js frame: East=x, Up=y, South=z. Therefore South = -North.
    const e = target.x;
    const n = target.y;
    const u = target.z;
    target.set(e, u, -n);
    return target;
  }

  function localToGeo(x, y, z, target) {
    // Input is Three.js frame: x=East, y=Up, z=South.
    // ENU expects: East=x, North=-z, Up=y.
    _ecef.set(x, -z, y).applyMatrix4(_baseFrame);
    WGS84_ELLIPSOID.getPositionToCartographic(_ecef, target);
    target.lat = THREE.MathUtils.radToDeg(target.lat);
    target.lon = THREE.MathUtils.radToDeg(target.lon);
    target.height = target.height || 0;
    return target;
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

  // ---- surface raycast --------------------------------------------------
  const _rc = new THREE.Raycaster();
  _rc.firstHitOnly = true;
  const _down = new THREE.Vector3(0, -1, 0);
  const _from = new THREE.Vector3();
  const _nmat = new THREE.Matrix3();
  function sampleGround(x, z) {
    _rc.set(_from.set(x, 9000, z), _down);
    _rc.far = 10000;
    const hits = _rc.intersectObject(tiles.group, true);
    return hits.length ? hits[0] : null;
  }

  // ---- OSM road network -------------------------------------------------
  let roadsData = null;     // Array<{name: string, highway: string, coords: Array<[lon, lat]>}>
  let roadGrid = null;      // RoadGrid — spatial index for nearest-road queries
  let roadsReady = false;   // true once grid is built (or on fetch failure)
  
  // ---- minimap ----------------------------------------------------------
  const minimapCanvas = document.getElementById('minimap');
  const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
  let roadPath2D = null;

  loadEl.textContent = 'Loading road network...';

  fetchRoads(ROAD_BBOX, ROAD_TYPES).then(roads => {
    roadsData = roads;
    loadEl.textContent = 'Roads loaded. Streaming terrain...';
  }).catch(err => {
    console.warn('OSM roads unavailable — driving unconstrained.', err);
    roadsReady = true;   // allow driving without road constraint
    loadEl.textContent = 'Roads unavailable. Streaming terrain...';
  });

  function tryBuildRoads() {
    if (roadsReady || !roadsData) return;

    // convert all road polylines to local XZ and build the spatial grid
    roadGrid = new RoadGrid(ROAD_GRID_CELL);
    if (minimapCtx) roadPath2D = new Path2D();
    
    const v = new THREE.Vector3();
    let segCount = 0;
    for (const road of roadsData) {
      let prevX, prevZ;
      for (let i = 0; i < road.coords.length; i++) {
        const [lon, lat] = road.coords[i];
        geoToLocal(lat, lon, 0, v);
        if (i > 0) {
          const isMajor = road.name && /^(motorway|trunk|primary|secondary|tertiary)$/.test(road.highway);
          roadGrid.addSegment(prevX, prevZ, v.x, v.z, isMajor ? road.name : undefined);
          segCount++;
          if (roadPath2D) {
            roadPath2D.moveTo(prevX, prevZ);
            roadPath2D.lineTo(v.x, v.z);
          }
        }
        prevX = v.x; prevZ = v.z;
      }
    }
    console.log(`Road grid built: ${roadsData.length} ways, ${segCount} segments, ${roadGrid.cellCount} cells`);
    roadsReady = true;
  }

  // ---- free-drive state -------------------------------------------------
  const carPos = new THREE.Vector3();   // world position (XZ driven, Y from terrain)
  let heading = SPAWN_HEADING;          // yaw in radians (0 = +Z)
  let speed = 0;                        // m/s (positive = forward)
  let steerAngle = 0;                   // current wheel angle (radians, + = left)
  let smoothY = 0;
  const smoothNormal = new THREE.Vector3(0, 1, 0);
  const UP = new THREE.Vector3(0, 1, 0);

  // ---- input ------------------------------------------------------------
  const keys = {};
  const DRIVING_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    keys[e.code] = true;
    if (DRIVING_KEYS.includes(e.code)) e.preventDefault();
    if (e.code === 'KeyO') controls.enabled = !controls.enabled;
    if (e.code === 'KeyL' && window.activeEngine === 'mapbox') {
      if (mapboxMap) {
        const isNight = mapboxMap.getConfigProperty('basemap', 'lightPreset') === 'night';
        const nextMode = isNight ? 'day' : 'night';
        mapboxMap.setConfigProperty('basemap', 'lightPreset', nextMode);
        window.mapboxNightMode = !isNight;
      }
    }
    if (e.code === 'KeyR') { // reset to spawn
      const spawnTest = new THREE.Vector3();
      geoToLocal(SPAWN.lat, SPAWN.lon, 0, spawnTest);
      if (roadGrid && roadGrid.cellCount > 0) {
        const nearest = roadGrid.absoluteNearest(spawnTest.x, spawnTest.z);
        if (nearest.dist !== Infinity) {
          spawnTest.x = nearest.x;
          spawnTest.z = nearest.z;
        }
      }
      carPos.set(spawnTest.x, smoothY, spawnTest.z);
      heading = SPAWN_HEADING;
      speed = 0;
      steerAngle = 0;
    }
  });
  addEventListener('keyup', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    keys[e.code] = false;
    if (DRIVING_KEYS.includes(e.code)) e.preventDefault();
  });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // ---- spawn ------------------------------------------------------------
  let driveReady = false;
  let spawnSnapped = false;
  const spawnLocal = new THREE.Vector3();

  function tryStart() {
    if (driveReady || !carLoaded || !roadsReady) return;

    if (!spawnSnapped) {
      geoToLocal(SPAWN.lat, SPAWN.lon, 0, spawnLocal);
      if (roadGrid && roadGrid.cellCount > 0) {
        const nearest = roadGrid.absoluteNearest(spawnLocal.x, spawnLocal.z);
        if (nearest.dist !== Infinity) {
          spawnLocal.x = nearest.x;
          spawnLocal.z = nearest.z;
          // Align car to road
          SPAWN_HEADING = Math.atan2(nearest.dx, nearest.dz);
        }
      }
      spawnSnapped = true;
    }

    if (driveReady) return;
    const hit = sampleGround(spawnLocal.x, spawnLocal.z);
    if (!hit) {
      if (window.activeEngine === 'mapbox') {
        const ll = localToGeo(spawnLocal.x, 0, spawnLocal.z, {});
        const elev = (mapboxMap && mapboxMap.queryTerrainElevation) ? mapboxMap.queryTerrainElevation([ll.lon, ll.lat]) : 0;
        smoothY = elev || 0;
        smoothNormal.copy(UP);
        carPos.set(spawnLocal.x, smoothY, spawnLocal.z);
        heading = SPAWN_HEADING;
        driveReady = true;
        loadEl.style.opacity = 0;
        setTimeout(() => (loadEl.style.display = 'none'), 600);
      }
      return;   // wait until terrain has streamed in near the start
    }
    smoothY = hit.point.y;
    smoothNormal.copy(faceNormal(hit));
    carPos.set(spawnLocal.x, smoothY, spawnLocal.z);
    heading = SPAWN_HEADING;
    driveReady = true;
    loadEl.style.opacity = 0;
    setTimeout(() => (loadEl.style.display = 'none'), 600);
  }

  // ---- per-frame car update (bicycle model + road constraint) -----------
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _basis = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _qBank = new THREE.Quaternion();
  const _zAxis = new THREE.Vector3(0, 0, 1);

  function updateCar(dt) {
    // --- input mapping ---
    const wantThrottle = keys['KeyW'] || keys['ArrowUp'];
    const wantBrake    = keys['KeyS'] || keys['ArrowDown'];
    const wantLeft     = keys['KeyA'] || keys['ArrowLeft'];
    const wantRight    = keys['KeyD'] || keys['ArrowRight'];
    const wantHandbrake = keys['Space'];

    // --- steering ---
    let steerTarget = 0;
    if (wantLeft)  steerTarget += MAX_STEER;
    if (wantRight) steerTarget -= MAX_STEER;

    if (steerTarget !== 0) {
      // steer toward target
      const dir = Math.sign(steerTarget - steerAngle);
      steerAngle += dir * STEER_SPEED * dt;
      if (dir > 0 && steerAngle > steerTarget) steerAngle = steerTarget;
      if (dir < 0 && steerAngle < steerTarget) steerAngle = steerTarget;
    } else {
      // self-centre
      const dir = Math.sign(-steerAngle);
      steerAngle += dir * STEER_RETURN * dt;
      if (dir > 0 && steerAngle > 0) steerAngle = 0;
      if (dir < 0 && steerAngle < 0) steerAngle = 0;
    }

    // --- speed ---
    if (wantHandbrake) {
      // handbrake: strong decel toward zero
      if (speed > 0) speed = Math.max(0, speed - HANDBRAKE_DECEL * dt);
      else           speed = Math.min(0, speed + HANDBRAKE_DECEL * dt);
    } else if (wantThrottle && !wantBrake) {
      if (speed < 0) {
        // braking from reverse
        speed = Math.min(0, speed + BRAKE_DECEL * dt);
      } else {
        speed = Math.min(MAX_SPEED, speed + ACCEL * dt);
      }
    } else if (wantBrake && !wantThrottle) {
      if (speed > 0.5) {
        // braking forward
        speed = Math.max(0, speed - BRAKE_DECEL * dt);
      } else {
        // reverse
        speed = Math.max(-REVERSE_MAX, speed - ACCEL * 0.5 * dt);
      }
    } else {
      // coast down
      if (speed > 0) speed = Math.max(0, speed - COAST_DECEL * dt);
      else           speed = Math.min(0, speed + COAST_DECEL * dt);
    }

    // --- bicycle model: update heading ---
    if (Math.abs(speed) > 0.01) {
      const turnRate = (speed / WHEELBASE) * Math.tan(steerAngle);
      heading += turnRate * dt;
    }

    // --- move position (with Mapbox collision detection) ---
    const nextX = carPos.x + speed * Math.sin(heading) * dt;
    const nextZ = carPos.z + speed * Math.cos(heading) * dt;

    let hitObstacle = false;
    if (window.activeEngine === 'mapbox' && typeof mapboxMap !== 'undefined' && mapboxMap && Math.abs(speed) > 0.1) {
      const nextGeo = localToGeo(nextX, 0, nextZ, {});
      const screenPt = mapboxMap.project([nextGeo.lon, nextGeo.lat]);
      
      // Query what rendered features are exactly at the car's future location
      const features = mapboxMap.queryRenderedFeatures(screenPt);
      for (let i = 0; i < features.length; i++) {
        const type = features[i].layer.type;
        const id = (features[i].layer.id || '').toLowerCase();
        
        // Block if the feature is a 3D building, 3D model, or water body
        if (type === 'fill-extrusion' || type === 'model' || id.includes('water')) {
          hitObstacle = true;
          break;
        }
      }
    }

    if (hitObstacle) {
      // Bounce the car backward and kill speed
      speed = -speed * 0.4;
    } else {
      carPos.x = nextX;
      carPos.z = nextZ;
    }

    // --- road constraint ---
    // Clamp the car to the nearest OSM road and raycast at the road's
    // centerline position so the height comes from the road surface,
    // not building roofs or photogrammetry clutter.
    let rayX = carPos.x, rayZ = carPos.z;
    if (roadGrid && window.activeEngine === 'google') {
      const nearest = roadGrid.nearest(carPos.x, carPos.z);
      if (nearest.dist < 100) {            // only constrain when a road is nearby
        if (nearest.dist > ROAD_HALF_WIDTH) {
          // push car back to road edge
          const dx = carPos.x - nearest.x;
          const dz = carPos.z - nearest.z;
          const d = Math.max(nearest.dist, 1e-6);
          carPos.x = nearest.x + (dx / d) * ROAD_HALF_WIDTH;
          carPos.z = nearest.z + (dz / d) * ROAD_HALF_WIDTH;

          // kill lateral speed component so you don't slide along the wall
          if (speed > 0) speed *= 0.92;
        }
        // raycast at the road centerline, not the car position
        rayX = nearest.x;
        rayZ = nearest.z;
      }
    }

    // --- terrain height (raycasted at road position) ---
    const hit = sampleGround(rayX, rayZ);
    if (hit) {
      smoothY = THREE.MathUtils.lerp(smoothY, hit.point.y, 0.25);
      smoothNormal.lerp(faceNormal(hit), 0.18).normalize();
    } else if (window.activeEngine === 'mapbox') {
      const ll = localToGeo(rayX, 0, rayZ, {});
      const elev = (mapboxMap && mapboxMap.queryTerrainElevation) ? mapboxMap.queryTerrainElevation([ll.lon, ll.lat]) : 0;
      smoothY = THREE.MathUtils.lerp(smoothY, elev || 0, 0.25);
      smoothNormal.lerp(UP, 0.18).normalize();
    }
    carPos.y = smoothY + 0.05;

    // --- orient car ---
    carGroup.position.copy(carPos);
    _fwd.set(Math.sin(heading), 0, Math.cos(heading)).normalize();

    // bank into turns
    const bank = THREE.MathUtils.clamp(-steerAngle * speed * BANK_GAIN * 2, -BANK_MAX, BANK_MAX);
    orientCar(_fwd, smoothNormal, bank);

    // --- wheels ---
    const droll = SPIN_SIGN * (speed * dt) / WHEEL_RADIUS;
    for (const w of wheels) w.rotation.x += droll;
  }

  function orientCar(forward, up, bank) {
    _right.crossVectors(forward, up).normalize();
    const _adjFwd = new THREE.Vector3();
    _adjFwd.crossVectors(up, _right).normalize();
    _basis.makeBasis(_right, up, _adjFwd.negate());
    _q.setFromRotationMatrix(_basis);
    _q.multiply(_qBank.setFromAxisAngle(_zAxis, bank));
    carGroup.quaternion.slerp(_q, 0.2);
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
    _camFwd.set(Math.sin(heading), 0, Math.cos(heading)).normalize();
    _camGoal.copy(carGroup.position).addScaledVector(_camFwd, -CHASE_BACK).addScaledVector(UP, CHASE_UP);
    const k = 1 - Math.exp(-CHASE_LERP * dt);
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, _camGoal.x, k);
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, _camGoal.z, k);
    camera.position.y = _camGoal.y;
    _look.copy(carGroup.position).addScaledVector(UP, LOOK_H);
    camera.lookAt(_look);
  }

  // ---- sim interface ----------------------------------------------------
  const sim = {
    getState: () => {
      const geo = localToGeo(carPos.x, carPos.y, carPos.z, {});
      return {
        x: carPos.x,
        y: carPos.y,
        z: carPos.z,
        lat: geo.lat,
        lon: geo.lon,
        heading: heading,
        speed: speed,
        steerAngle: steerAngle
      };
    },
    update: (dt) => {
      updateCar(dt);
    }
  };

  // ---- engine toggle (Google photoreal tiles ⇄ Mapbox vector) -----------
  // Phase 1 scaffolding: Mapbox renders the clean city in its own GL context;
  // the Three.js loop pauses while it's active. (Car + shared sim come next.)
  let engine = 'google';
  let mapboxMap = null;
  let mapboxFatalError = false;
  const mapEl = document.getElementById('map');
  const mapStatusEl = document.getElementById('mapStatus');
  const mapStatusTitle = document.getElementById('mapStatusTitle');
  const mapStatusDetail = document.getElementById('mapStatusDetail');
  const toggleBtn = document.getElementById('engineToggle');

  function showMapboxNotice(title, detail) {
    if (!mapStatusEl) return;
    if (mapStatusTitle) mapStatusTitle.textContent = title;
    if (mapStatusDetail) mapStatusDetail.textContent = detail;
    mapStatusEl.style.display = 'flex';
  }

  function hideMapboxNotice() {
    if (mapStatusEl) mapStatusEl.style.display = 'none';
  }

  function setMapboxStatus(status, detail = '') {
    if (!mapEl) return;
    mapEl.dataset.mapboxStatus = status;
    mapEl.dataset.mapboxDetail = detail;
    if (status === 'initializing' || status === 'loading' || status === 'styledata' || status === 'sourcedata') {
      showMapboxNotice('Loading Mapbox', detail || 'Fetching map style and tiles...');
    } else if (status === 'loaded' || status === 'idle' || status === 'style-loaded') {
      if (mapboxFatalError) return;
      hideMapboxNotice();
    } else if (status === 'error') {
      showMapboxNotice('Mapbox could not load', detail || 'Check the Mapbox token and allowed domains.');
    }
  }

  function initMapbox() {
    if (mapboxMap || !MAPBOX_TOKEN) return;
    mapboxFatalError = false;
    setMapboxStatus('initializing');
    mapboxgl.accessToken = MAPBOX_TOKEN;
    mapboxMap = new mapboxgl.Map({
      container: mapEl,
      style: 'mapbox://styles/mapbox/standard',
      center: [SPAWN.lon, SPAWN.lat],
      zoom: 16.5, pitch: 62, bearing: 180, antialias: true,
      interactive: false   // disable all mouse/touch/keyboard — we control the camera
    });
    mapboxMap.scrollZoom.disable();
    mapboxMap.boxZoom.disable();
    mapboxMap.dragPan.disable();
    mapboxMap.dragRotate.disable();
    mapboxMap.keyboard.disable();
    mapboxMap.doubleClickZoom.disable();
    mapboxMap.touchZoomRotate.disable();
    const updateMapboxStatus = (status = 'loading') => {
      try {
        const style = mapboxMap.getStyle();
        const layers = style && style.layers ? style.layers.length : 0;
        const sources = style && style.sources ? Object.keys(style.sources).length : 0;
        setMapboxStatus(
          mapboxMap.isStyleLoaded() ? 'style-loaded' : status,
          `${layers} layers, ${sources} sources, loaded=${mapboxMap.loaded()}`
        );
      } catch (err) {
        setMapboxStatus(status, err && err.message ? err.message : String(err));
      }
    };
    mapboxMap.on('styledata', () => updateMapboxStatus('styledata'));
    mapboxMap.on('sourcedata', () => updateMapboxStatus('sourcedata'));
    mapboxMap.on('load', () => {
      const style = mapboxMap.getStyle();
      addMapboxBuildings();
      addMapboxCarLayer();
      setMapboxStatus('loaded', `${style.layers ? style.layers.length : 0} layers`);
      console.log('mapbox loaded:', style.layers ? style.layers.length : 0, 'layers');
      window.mapboxMap = mapboxMap;
    });
    mapboxMap.on('idle', () => {
      updateMapboxStatus('idle');
      mapEl.dataset.mapboxStatus = 'idle';
    });
    mapboxMap.on('error', e => {
      const x = (e && e.error) || e || {};
      let msg = x.message || x.statusText || x.type || 'unknown error';
      if (x.status === 401 || x.status === 403) {
        mapboxFatalError = true;
        msg = `Mapbox rejected this token for ${location.origin}. Add this origin to the token URL restrictions or use an unrestricted development token.`;
      }
      const safeUrl = x.url ? String(x.url).replace(/(access_token=)[^&\s]+/g, '$1[redacted]') : '';
      setMapboxStatus('error', `${x.status || ''} ${msg}`.trim());
      console.warn('mapbox error:', x.name || (x.constructor && x.constructor.name) || x.type, '| status', x.status, '| url', safeUrl, '| msg', msg);
    });
  }

  function addMapboxBuildings() {
    if (!mapboxMap || mapboxMap.getLayer('eleanor-3d-buildings')) return;
    const style = mapboxMap.getStyle();
    
    // Mapbox Standard v3 natively includes 3D buildings; do not inject manual extrusions
    if (style.name && style.name.toLowerCase().includes('standard')) return;
    
    const labelLayer = style.layers && style.layers.find(layer =>
      layer.type === 'symbol' &&
      layer.layout &&
      layer.layout['text-field']
    );
    if (!style.sources || !style.sources.composite) return;
    mapboxMap.addLayer({
      id: 'eleanor-3d-buildings',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', ['get', 'extrude'], 'true'],
      type: 'fill-extrusion',
      minzoom: 15,
      paint: {
        'fill-extrusion-color': '#b8c1cc',
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'],
          15, 0,
          15.05, ['coalesce', ['get', 'height'], 0]
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'],
          15, 0,
          15.05, ['coalesce', ['get', 'min_height'], 0]
        ],
        'fill-extrusion-opacity': 0.72
      }
    }, labelLayer && labelLayer.id);
  }

  function addMapboxCarLayer() {
    if (!mapboxMap || mapboxMap.getLayer('eleanor-car')) return;
    
    const customLayer = {
      id: 'eleanor-car',
      type: 'custom',
      renderingMode: '3d',
      onAdd: function(map, gl) {
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.map = map;

        // Clone the car model for Mapbox scene so we can position it independently
        this.mapboxCar = carGroup.clone(true);
        this.mapboxCar.traverse(child => {
          child.frustumCulled = false;
        });
        this.scene.add(this.mapboxCar);

        // Cache destination wheel references for syncing each frame
        this.dstWheels = [];
        this.mapboxCar.traverse(o => {
          if (o.name && o.name.startsWith('Wheel_') && o.name.endsWith('_ctrl')) this.dstWheels.push(o);
        });

        this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        this.directionalLight.position.set(0, 70, 50);
        this.scene.add(this.directionalLight);

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(this.ambientLight);

        this.renderer = new THREE.WebGLRenderer({
          canvas: map.getCanvas(),
          context: gl,
          antialias: true
        });
        this.renderer.autoClear = false;
      },
      render: function(gl, matrix) {
        if (window.activeEngine !== 'mapbox' || !driveReady) return;

        // Copy the exact orientation and wheel state from the physics carGroup
        this.mapboxCar.position.set(0, 0, 0);
        this.mapboxCar.quaternion.copy(carGroup.quaternion);

        // Copy wheel rotations
        for (let i = 0; i < Math.min(wheels.length, this.dstWheels.length); i++) {
          this.dstWheels[i].rotation.copy(wheels[i].rotation);
        }

        const state = sim.getState();
        const merc = mapboxgl.MercatorCoordinate.fromLngLat([state.lon, state.lat], state.y);
        const scale = merc.meterInMercatorCoordinateUnits();

        // Standard Mapbox model matrix:
        // 1. Translate to Mercator position
        // 2. Scale from meters to Mercator units
        // 3. Rotate from Three.js coords (Y-up) to Mapbox coords (Z-up)
        //    Three.js: X=right, Y=up, Z=toward-viewer
        //    Mapbox:   X=east,  Y=south, Z=up
        //    Rotation: 90° around X axis flips Y↔Z
        const l = new THREE.Matrix4()
          .makeTranslation(merc.x, merc.y, merc.z)
          .scale(new THREE.Vector3(scale, -scale, scale))
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));

        const m = new THREE.Matrix4().fromArray(matrix);
        this.camera.projectionMatrix = m.multiply(l);
        
        // Sync lighting to day/night
        if (window.mapboxNightMode) {
          this.directionalLight.intensity = 0.0;
          this.ambientLight.intensity = 0.15;
        } else {
          this.directionalLight.intensity = 1.5;
          this.ambientLight.intensity = 0.6;
        }
        
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
        
        updateMapboxChaseCam(state);
        this.map.triggerRepaint();
      }
    };
    
    mapboxMap.addLayer(customLayer);
  }

  function updateMapboxChaseCam(state) {
    if (!mapboxMap) return;
    
    // Mapbox bearing is degrees clockwise from North (0=North, 90=East, 180=South)
    // Our simulation heading is 0 when facing +Z (South).
    const mapboxBearing = 180 - THREE.MathUtils.radToDeg(state.heading);
    
    mapboxMap.jumpTo({
      center: [state.lon, state.lat],
      bearing: mapboxBearing,
      pitch: 75,
      zoom: 19.5
    });
  }

  function setEngine(name) {
    window.activeEngine = name;
    if (name === 'mapbox' && !MAPBOX_TOKEN) {
      engine = name;
      mapEl.style.display = 'block';
      renderer.domElement.style.display = 'none';
      loadEl.style.display = 'none';
      showMapboxNotice('Mapbox token required', 'Add VITE_MAPBOX_TOKEN to web/.env.local or store MAPBOX_TOKEN in localStorage.');
      if (toggleBtn) toggleBtn.textContent = 'Google';
      return;
    }
    engine = name;
    if (name === 'mapbox') {
      mapEl.style.display = 'block';
      renderer.domElement.style.display = 'none';
      loadEl.style.display = 'none';
      initMapbox();
      if (mapboxMap) mapboxMap.resize();
      if (mapboxFatalError) {
        showMapboxNotice('Mapbox could not load', mapEl.dataset.mapboxDetail || 'Check the Mapbox token and allowed domains.');
      }
      if (toggleBtn) toggleBtn.textContent = 'Google';
    } else {
      mapEl.style.display = 'none';
      hideMapboxNotice();
      renderer.domElement.style.display = 'block';
      if (!GOOGLE_KEY) {
        document.getElementById('token').style.display = 'flex';
      } else if (!driveReady) {
        loadEl.style.display = 'flex'; loadEl.style.opacity = '1';
      }
      if (toggleBtn) toggleBtn.textContent = 'Mapbox';
    }
  }
  if (toggleBtn) toggleBtn.addEventListener('click', () => setEngine(engine === 'google' ? 'mapbox' : 'google'));
  if (INITIAL_ENGINE === 'mapbox') setEngine('mapbox');   // deep-link straight into Mapbox mode

  // ---- loop -------------------------------------------------------------
  const clock = new THREE.Clock();

  function runSimAndHUD(dt) {
    tryBuildRoads();
    tryStart();

    if (driveReady) {
      sim.update(dt);
      speedEl.textContent = Math.round(Math.abs(speed) * 3.6) + ' km/h';
    }

    // --- render minimap ---
    if (minimapCtx && roadPath2D && driveReady) {
      minimapCtx.clearRect(0, 0, 160, 160);
      minimapCtx.save();
      
      minimapCtx.translate(80, 80);
      minimapCtx.rotate(heading + Math.PI);
      
      const scale = 0.2; // 1 pixel = 5 meters
      minimapCtx.scale(scale, scale);
      minimapCtx.translate(-carPos.x, -carPos.z);
      
      // Draw roads
      minimapCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      minimapCtx.lineWidth = 2 / scale;
      minimapCtx.lineCap = 'round';
      minimapCtx.lineJoin = 'round';
      minimapCtx.stroke(roadPath2D);
      
      // Draw street names
      minimapCtx.font = '11px system-ui, sans-serif';
      minimapCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      minimapCtx.textAlign = 'center';
      minimapCtx.textBaseline = 'middle';
      
      // Localized street names
      if (roadGrid) {
        const visibleNames = new Map();
        const segments = roadGrid.getSegmentsInRadius(carPos.x, carPos.z, 400);
        
        for (const seg of segments) {
          const [px, pz, dist] = projectOnSegment(carPos.x, carPos.z, seg.ax, seg.az, seg.bx, seg.bz);
          
          if (!visibleNames.has(seg.name) || dist < visibleNames.get(seg.name).dist) {
            visibleNames.set(seg.name, {
              x: px,
              z: pz,
              angle: Math.atan2(seg.bz - seg.az, seg.bx - seg.ax),
              dist: dist
            });
          }
        }
        
        for (const [name, label] of visibleNames.entries()) {
          minimapCtx.save();
          minimapCtx.translate(label.x, label.z);
          
          const mapRot = heading + Math.PI;
          let absRot = mapRot + label.angle;
          absRot = (absRot % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
          let flip = (absRot > Math.PI / 2 && absRot < Math.PI * 1.5);
          
          minimapCtx.rotate(label.angle + (flip ? Math.PI : 0));
          minimapCtx.scale(1/scale, 1/scale);
          
          minimapCtx.shadowColor = 'rgba(0,0,0,0.8)';
          minimapCtx.shadowBlur = 4;
          minimapCtx.fillText(name, 0, flip ? 6 : -6);
          
          minimapCtx.restore();
        }
      }
      
      minimapCtx.restore();
      
      // Draw car (always centered, pointing up)
      minimapCtx.fillStyle = '#3b82f6';
      minimapCtx.beginPath();
      minimapCtx.moveTo(80, 74);
      minimapCtx.lineTo(85, 84);
      minimapCtx.lineTo(80, 81);
      minimapCtx.lineTo(75, 84);
      minimapCtx.fill();
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);

    // Always run physics + HUD regardless of active engine
    runSimAndHUD(dt);

    if (engine === 'google') {
      // Google-specific rendering
      if (carGroup.parent !== scene) scene.add(carGroup);

      if (driveReady) {
        if (!controls.enabled) updateChase(dt);
      } else if (controls.enabled) {
        controls.update();
      }

      camera.updateMatrixWorld();
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
      updateAttribution();

      renderer.render(scene, camera);
    }
    // Mapbox renders via its own custom layer render() callback
  }
  requestAnimationFrame(tick);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ---- OSM road fetching (module scope) -----------------------------------
async function fetchRoads(bbox, types) {
  const cacheKey = `osm_roads_v3:${bbox}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      console.log(`OSM roads loaded from cache (${parsed.length} ways)`);
      return parsed;
    } catch (e) { /* cache corrupt, re-fetch */ }
  }

  const query = `[out:json][timeout:30];way["highway"~"^(${types})$"](${bbox});(._;>;);out body;>;out skel qt;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = await res.json();

  // Parse into compact coordinate arrays: Array<Array<[lon, lat]>>
  const nodes = new Map();
  const roads = [];
  for (const el of json.elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
  }
  for (const el of json.elements) {
    if (el.type === 'way' && el.nodes) {
      const coords = el.nodes.map(id => nodes.get(id)).filter(Boolean);
      const name = el.tags && el.tags.name ? el.tags.name : '';
      const highway = el.tags && el.tags.highway ? el.tags.highway : '';
      if (coords.length >= 2) roads.push({ name, highway, coords });
    }
  }

  try { localStorage.setItem(cacheKey, JSON.stringify(roads)); } catch (e) {
    console.warn('Could not cache road data in localStorage:', e);
  }
  console.log(`OSM roads fetched: ${roads.length} ways`);
  return roads;
}

// ---- 2D spatial grid for nearest-road queries ---------------------------
// Projects the car onto the closest road segment in O(1) average time.
class RoadGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  get cellCount() { return this.cells.size; }

  _key(cx, cz) { return (cx * 73856093) ^ (cz * 19349663); }   // int hash — faster than string concat

  addSegment(ax, az, bx, bz, name) {
    const cs = this.cellSize;
    const minCx = Math.floor(Math.min(ax, bx) / cs);
    const maxCx = Math.floor(Math.max(ax, bx) / cs);
    const minCz = Math.floor(Math.min(az, bz) / cs);
    const maxCz = Math.floor(Math.max(az, bz) / cs);
    const seg = { ax, az, bx, bz, name };
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const k = this._key(cx, cz);
        let bucket = this.cells.get(k);
        if (!bucket) { bucket = []; this.cells.set(k, bucket); }
        bucket.push(seg);
      }
    }
  }

  getSegmentsInRadius(x, z, r) {
    const cs = this.cellSize;
    const cx0 = Math.floor(x / cs), cz0 = Math.floor(z / cs);
    const range = Math.ceil(r / cs);
    const result = [];
    const seen = new Set();
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        const k = this._key(cx0 + dx, cz0 + dz);
        const bucket = this.cells.get(k);
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) {
            const seg = bucket[i];
            if (seg.name && !seen.has(seg)) {
              seen.add(seg);
              result.push(seg);
            }
          }
        }
      }
    }
    return result;
  }

  nearest(x, z) {
    const cs = this.cellSize;
    const cx0 = Math.floor(x / cs), cz0 = Math.floor(z / cs);
    let bestDist = Infinity, bestX = x, bestZ = z;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const k = this._key(cx0 + dx, cz0 + dz);
        const bucket = this.cells.get(k);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const s = bucket[i];
          const [px, pz, d] = projectOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
          if (d < bestDist) { bestDist = d; bestX = px; bestZ = pz; }
        }
      }
    }
    return { x: bestX, z: bestZ, dist: bestDist };
  }

  absoluteNearest(x, z) {
    let bestDist = Infinity, bestX = x, bestZ = z, bestDx = 0, bestDz = -1;
    for (const bucket of this.cells.values()) {
      for (let i = 0; i < bucket.length; i++) {
        const s = bucket[i];
        const [px, pz, d, rdx, rdz] = projectOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
        if (d < bestDist) { bestDist = d; bestX = px; bestZ = pz; bestDx = rdx; bestDz = rdz; }
      }
    }
    return { x: bestX, z: bestZ, dist: bestDist, dx: bestDx, dz: bestDz };
  }
}

function projectOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-8) {
    const d = Math.hypot(px - ax, pz - az);
    return [ax, az, d, 0, -1];
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * dx, projZ = az + t * dz;
  // normalize dx, dz for the segment direction
  const len = Math.sqrt(len2);
  return [projX, projZ, Math.hypot(px - projX, pz - projZ), dx / len, dz / len];
}

// ---- helpers (module scope) ---------------------------------------------
function loadCar(carGroup, wheels, bodyMat, done) {
  const STRIPE_INNER = 0.05, STRIPE_OUTER = 0.27;
  const gltfLoader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  gltfLoader.setDRACOLoader(draco);
  gltfLoader.load(eleanorGlb, (gltf) => {
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
