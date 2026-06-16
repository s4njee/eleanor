// mapboxRenderer.js — the "clean vector" engine: Mapbox GL JS.
//
// The other interchangeable renderer. Unlike Google (which renders inside our
// Three.js scene), Mapbox GL is its OWN WebGL engine that draws the map itself.
// We inject the car by registering a Three.js "custom layer" that shares Mapbox's
// GL context and draws the model at the right spot every frame.
//
// It implements the same small surface the app expects from an engine:
//   - sampleHeight(x,z) — ground height, from Mapbox terrain elevation
//   - show() / hide()   — become / stop being the active engine
// Plus a day/night toggle that's unique to Mapbox's Standard style.

import * as THREE from 'three';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const UP = new THREE.Vector3(0, 1, 0);

export function createMapboxRenderer({ container, token, sim, vehicles, geo, spawn }) {
  const { localToGeo } = geo;
  const { carGroup, wheels } = vehicles;

  let map = null;
  let active = false;        // are we the engine currently on screen?
  let nightMode = false;     // day/night lighting toggle (the 'L' key)
  let fatalError = false;    // 401/403 etc. — token rejected
  const _geoTmp = {};

  // ---- status overlay (so auth/style failures aren't a silent white screen) --
  const statusEl = document.getElementById('mapStatus');
  const titleEl = document.getElementById('mapStatusTitle');
  const detailEl = document.getElementById('mapStatusDetail');
  function showNotice(title, detail) {
    if (!statusEl) return;
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
    statusEl.style.display = 'flex';
  }
  function hideNotice() { if (statusEl) statusEl.style.display = 'none'; }

  // ---- the car custom layer -----------------------------------------------
  // A Mapbox "custom layer" gets handed the GL context + the map's projection
  // matrix each frame. We run a tiny secondary Three.js renderer on that context
  // to draw a clone of the car at the simulation's current lat/lon/heading.
  function carCustomLayer() {
    return {
      id: 'eleanor-car',
      type: 'custom',
      renderingMode: '3d',
      onAdd(layerMap, gl) {
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();

        this.car = carGroup.clone(true);                    // independent copy for this scene
        this.car.traverse(o => { o.frustumCulled = false; });
        this.scene.add(this.car);

        this.dstWheels = [];                                // wheels to sync with the sim's
        this.car.traverse(o => {
          if (o.name && o.name.startsWith('Wheel_') && o.name.endsWith('_ctrl')) this.dstWheels.push(o);
        });

        this.dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        this.dirLight.position.set(0, 70, 50);
        this.scene.add(this.dirLight);
        this.ambLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(this.ambLight);

        this.renderer = new THREE.WebGLRenderer({ canvas: layerMap.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
      },
      render(gl, matrix) {
        if (!active || !sim.driveReady) return;

        // copy pose + wheel spin from the shared (physics-driven) car
        this.car.position.set(0, 0, 0);
        this.car.quaternion.copy(carGroup.quaternion);
        for (let i = 0; i < Math.min(wheels.length, this.dstWheels.length); i++) {
          this.dstWheels[i].rotation.copy(wheels[i].rotation);
        }

        const state = sim.getState();
        const merc = mapboxgl.MercatorCoordinate.fromLngLat([state.lon, state.lat], state.y);
        const scale = merc.meterInMercatorCoordinateUnits();

        // Build the model matrix: place at the mercator position, scale metres ->
        // mercator units, and rotate Three.js (Y-up) into Mapbox (Z-up) space.
        const model = new THREE.Matrix4()
          .makeTranslation(merc.x, merc.y, merc.z)
          .scale(new THREE.Vector3(scale, -scale, scale))
          .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(model);

        if (nightMode) { this.dirLight.intensity = 0.0; this.ambLight.intensity = 0.15; }
        else           { this.dirLight.intensity = 1.5; this.ambLight.intensity = 0.6; }

        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);

        updateChaseCam(state);
        layerMap.triggerRepaint();   // keep animating while we're the active engine
      },
    };
  }

  // ---- chase camera: point Mapbox's free camera at the car ----------------
  function updateChaseCam(state) {
    if (!map) return;
    // Mapbox bearing = degrees clockwise from North; our heading is 0 at +Z/South.
    const bearing = 180 - THREE.MathUtils.radToDeg(state.heading);
    const isPlane = sim.vehicle === 'plane';
    map.jumpTo({
      center: [state.lon, state.lat],
      bearing,
      pitch: isPlane ? 50 : 75,
      zoom: isPlane ? 14.0 : 19.5,
    });
  }

  // ---- create the map (lazily, the first time we switch to Mapbox) --------
  function init() {
    if (map || !token) return;
    fatalError = false;
    showNotice('Loading Mapbox', 'Fetching map style and tiles…');
    mapboxgl.accessToken = token;
    map = new mapboxgl.Map({
      container,
      style: 'mapbox://styles/mapbox/standard',   // v3 Standard: native 3D buildings + lighting
      center: [spawn.lon, spawn.lat],
      zoom: 16.5, pitch: 62, bearing: 180, antialias: true,
      interactive: false,   // we control the camera; disable all user gestures
    });
    // belt-and-braces: kill every interaction handler
    for (const h of ['scrollZoom', 'boxZoom', 'dragPan', 'dragRotate', 'keyboard', 'doubleClickZoom', 'touchZoomRotate']) {
      map[h].disable();
    }

    map.on('load', () => {
      map.addLayer(carCustomLayer());
      hideNotice();
    });
    map.on('error', (e) => {
      const x = (e && e.error) || e || {};
      let msg = x.message || x.statusText || x.type || 'unknown error';
      if (x.status === 401 || x.status === 403) {
        fatalError = true;
        msg = `Mapbox rejected this token for ${location.origin}. Add this origin to the token's URL restrictions or use an unrestricted dev token.`;
        showNotice('Mapbox could not load', msg);
      }
      const safeUrl = x.url ? String(x.url).replace(/(access_token=)[^&\s]+/g, '$1[redacted]') : '';
      console.warn('mapbox error:', x.status || '', msg, safeUrl);
    });
  }

  // ground height from Mapbox terrain (the car follows the streets' elevation)
  function sampleHeight(x, z) {
    const ll = localToGeo(x, 0, z, _geoTmp);
    const elev = (map && map.queryTerrainElevation) ? map.queryTerrainElevation([ll.lon, ll.lat]) : 0;
    return { y: elev || 0, normal: UP };
  }

  function toggleDayNight() {
    if (!map) return;
    nightMode = map.getConfigProperty('basemap', 'lightPreset') === 'night' ? false : true;
    map.setConfigProperty('basemap', 'lightPreset', nightMode ? 'night' : 'day');
  }

  function show() {
    active = true;
    container.style.display = 'block';
    if (!token) { showNotice('Mapbox token required', 'Add VITE_MAPBOX_TOKEN to web/.env.local or store MAPBOX_TOKEN in localStorage.'); return; }
    init();
    if (map) { map.resize(); map.triggerRepaint(); }
    if (fatalError) showNotice('Mapbox could not load', 'Check the Mapbox token and allowed domains.');
  }

  function hide() {
    active = false;
    container.style.display = 'none';
    hideNotice();
  }

  return {
    show, hide, sampleHeight, toggleDayNight,
    get hasToken() { return !!token; },
    get fatalError() { return fatalError; },
  };
}
