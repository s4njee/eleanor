// drive.js — entry point for the free-drive city app.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ BIG PICTURE                                                              │
// │                                                                          │
// │ You drive a car (or fly an SR-71) around a real city on real roads. The  │
// │ city can be rendered by either of two interchangeable "engines":         │
// │                                                                          │
// │   • Google  — photoreal 3D tiles inside a Three.js scene  (googleRenderer)│
// │   • Mapbox  — clean vector buildings in Mapbox GL JS       (mapboxRenderer)│
// │                                                                          │
// │ Both engines share ONE simulation (sim.js): the same car state, physics, │
// │ and OSM road network. An engine only has to do two things for the sim —  │
// │ tell it the ground height under a point (sampleHeight) and show/hide      │
// │ itself. So switching engines is just swapping which one is on screen and  │
// │ whose sampleHeight the physics uses; the car keeps its exact position.   │
// │                                                                          │
// │ Data flow each frame (see the loop at the bottom):                       │
// │   roads.streamAround(...)   load nearby roads as you move                │
// │   sim.trySpawn / sim.update advance the car using the active sampleHeight │
// │   minimap.draw()            redraw the corner map                        │
// │   <engine>.render(...)      paint the city                              │
// │                                                                          │
// │ This file just wires those modules together and handles the toggles +    │
// │ the city search box. The interesting code lives in ./drive/*.js.         │
// └─────────────────────────────────────────────────────────────────────────┘

import * as THREE from 'three';
import * as cfg from './drive/config.js';
import { createGeoFrame } from './drive/geo.js';
import { createRoadNetwork } from './drive/roads.js';
import { createInput } from './drive/input.js';
import { createVehicles } from './drive/vehicles.js';
import { createSim } from './drive/sim.js';
import { createMinimap } from './drive/minimap.js';
import { createGoogleRenderer } from './drive/googleRenderer.js';
import { createMapboxRenderer } from './drive/mapboxRenderer.js';

const loadEl = document.getElementById('load');
const speedEl = document.getElementById('speed');

function setLoadStatus(text) {
  if (loadEl) loadEl.textContent = text;
}

function hideLoad() {
  loadEl.style.opacity = 0;
  setTimeout(() => (loadEl.style.display = 'none'), 600);
}

// The engine currently on screen. The search box reads this so it can preserve
// the engine across the page reload it triggers.
let activeEngine = cfg.INITIAL_ENGINE;

// ---- city search (Nominatim) — reloads the page at the new location --------
setupSearch();
function setupSearch() {
  const form = document.getElementById('searchForm');
  const input = document.getElementById('searchInput');
  if (!form || !input) return;
  if (cfg.spawnName !== 'Times Square') input.placeholder = `Driving in ${cfg.spawnName}`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const btn = form.querySelector('button');
    btn.textContent = '...';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
      const data = await res.json();
      if (data && data.length > 0) {
        const loc = data[0];
        const engParam = activeEngine === 'mapbox' ? '&engine=mapbox' : '';
        location.href = `?lat=${loc.lat}&lon=${loc.lon}&name=${encodeURIComponent(q)}${engParam}`;
      } else {
        alert('City not found.');
        btn.textContent = 'Go';
      }
    } catch (err) {
      alert('Search failed.');
      btn.textContent = 'Go';
    }
  });
}

// ---- Google Maps API key gate ----------------------------------------------
// Google mode needs a key. If we don't have one (and aren't booting into Mapbox),
// show the paste-a-key prompt instead of starting.
if (!cfg.GOOGLE_KEY && cfg.INITIAL_ENGINE !== 'mapbox') {
  loadEl.style.display = 'none';
  document.getElementById('token').style.display = 'flex';
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
  // ---- build the shared pieces ----
  const geo = createGeoFrame(cfg.SPAWN);
  const roads = createRoadNetwork(geo.geoToLocal, {
    onFirstTile: () => setLoadStatus('Streaming terrain…'),
  });
  const input = createInput();
  setLoadStatus('Loading terrain & vehicle…');

  // ---- the two engines + the vehicles they share ----
  const google = createGoogleRenderer({
    canvas: document.getElementById('c'),
    googleKey: cfg.GOOGLE_KEY,
    spawn: cfg.SPAWN,
    loadEl,
  });
  const vehicles = createVehicles(google.renderer);   // needs a renderer to bake car reflections
  google.scene.add(vehicles.carGroup);
  google.scene.add(vehicles.planeGroup);

  const sim = createSim({ geo, roads, vehicles, keys: input.keys });
  const minimap = createMinimap(document.getElementById('minimap'), sim, roads);
  const mapbox = createMapboxRenderer({
    container: document.getElementById('map'),
    token: cfg.MAPBOX_TOKEN,
    sim, vehicles, geo,
    spawn: cfg.SPAWN,
  });

  // ---- engine toggle (Google ⇄ Mapbox) ----
  const toggleBtn = document.getElementById('engineToggle');
  const vehicleToggleBtn = document.getElementById('vehicleToggle');

  function setVehicle(v) {
    sim.setVehicle(v);
    if (vehicleToggleBtn) vehicleToggleBtn.textContent = v === 'car' ? 'Eleanor' : 'SR-71';
  }

  function setEngine(name) {
    activeEngine = name;
    if (name === 'mapbox') {
      sceneRevealed = true;
      google.hide();
      loadEl.style.display = 'none';
      mapbox.show();
      if (toggleBtn) toggleBtn.textContent = 'Google';
      if (vehicleToggleBtn) vehicleToggleBtn.style.display = 'none';   // plane mode is Google-only
      setVehicle('car');
    } else {
      mapbox.hide();
      google.show();
      if (!cfg.GOOGLE_KEY) {
        document.getElementById('token').style.display = 'flex';
      } else if (!sim.driveReady) {
        loadEl.style.display = 'flex'; loadEl.style.opacity = '1';
      }
      if (toggleBtn) toggleBtn.textContent = 'Mapbox';
      if (vehicleToggleBtn) vehicleToggleBtn.style.display = 'block';
    }
  }

  if (toggleBtn) toggleBtn.addEventListener('click', () => setEngine(activeEngine === 'google' ? 'mapbox' : 'google'));
  if (vehicleToggleBtn) vehicleToggleBtn.addEventListener('click', () => setVehicle(sim.vehicle === 'car' ? 'plane' : 'car'));

  // ---- action keys ----
  input.on('KeyO', () => { if (activeEngine === 'google') google.toggleFreeLook(); });   // free-look
  input.on('KeyL', () => { if (activeEngine === 'mapbox') mapbox.toggleDayNight(); });    // day/night
  input.on('KeyR', () => sim.reset());                                                    // back to spawn

  let sceneRevealed = cfg.INITIAL_ENGINE === 'mapbox';
  if (cfg.INITIAL_ENGINE === 'mapbox') setEngine('mapbox');   // deep-link straight into Mapbox

  // ---- main loop ----
  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);

    const engine = activeEngine === 'mapbox' ? mapbox : google;
    const sampleHeight = engine.sampleHeight;
    const wide = sim.vehicle === 'plane';   // the plane prefetches roads further ahead

    // keep roads loaded around wherever we are (or spawn, before we've started)
    if (sim.driveReady) {
      const s = sim.getState();
      roads.streamAround(s.lat, s.lon, wide);
    } else {
      roads.streamAround(cfg.SPAWN.lat, cfg.SPAWN.lon, wide);
    }

    // place the car once models + ground are ready; OSM roads are only context
    if (!sim.driveReady) {
      const started = sim.trySpawn(sampleHeight);
      if (started) {
        sceneRevealed = true;
        hideLoad();
      }
    }

    // advance physics (terrain-height collision in both engines) + update the HUD
    if (sim.driveReady && sceneRevealed) {
      sim.update(dt, sampleHeight);
      speedEl.textContent = Math.round(Math.abs(sim.speed) * 3.6) + ' km/h';
    }

    minimap.draw();

    // Google paints here; Mapbox paints itself via its custom layer. Keep Google
    // rendering before spawn too, because tile traversal is what makes ground
    // raycasts available.
    if (activeEngine === 'google') google.render(dt, sim);
  }
  requestAnimationFrame(frame);

  addEventListener('resize', () => google.resize());
}
