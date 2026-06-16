// roads.js — where the road data comes from and how we make it fast to query.
//
// Three responsibilities:
//   1. fetchRoads()        — download road geometry from the OSM Overpass API.
//   2. RoadGrid            — a spatial index so "what road am I near?" is O(1).
//   3. createRoadNetwork() — ties them together and STREAMS roads in tiles as the
//                            vehicle moves, so the map never runs out of roads.
//
// The same data feeds spawn placement and the minimap. Collision does not depend
// on OSM roads; the sim uses sampled terrain height for that.

import * as THREE from 'three';
import { ROAD_TYPES, OVERPASS_ENDPOINTS, ROAD_GRID_CELL, ROAD_TILE_DEG } from './config.js';

// ---- geometry helper ----------------------------------------------------
// Closest point on segment A→B to point P. Returns [x, z, distance, dirX, dirZ]
// where (dirX,dirZ) is the unit direction of the segment.
export function projectOnSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-8) {                       // degenerate (A == B)
    const d = Math.hypot(px - ax, pz - az);
    return [ax, az, d, 0, -1];
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));         // clamp to the segment
  const projX = ax + t * dx, projZ = az + t * dz;
  const len = Math.sqrt(len2);
  return [projX, projZ, Math.hypot(px - projX, pz - projZ), dx / len, dz / len];
}

// ---- spatial grid -------------------------------------------------------
// Roads are chopped into segments and bucketed into square cells. To find the
// nearest road we only test segments in the handful of cells around the car,
// instead of every road in the city.
export class RoadGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  get cellCount() { return this.cells.size; }

  _key(cx, cz) { return (cx * 73856093) ^ (cz * 19349663); }   // int hash, cheaper than a string

  addSegment(ax, az, bx, bz, name, width) {
    const cs = this.cellSize;
    const minCx = Math.floor(Math.min(ax, bx) / cs);
    const maxCx = Math.floor(Math.max(ax, bx) / cs);
    const minCz = Math.floor(Math.min(az, bz) / cs);
    const maxCz = Math.floor(Math.max(az, bz) / cs);
    const seg = { ax, az, bx, bz, name, width };
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const k = this._key(cx, cz);
        let bucket = this.cells.get(k);
        if (!bucket) { bucket = []; this.cells.set(k, bucket); }
        bucket.push(seg);
      }
    }
  }

  // All named segments within radius r — used by the minimap to label streets.
  getSegmentsInRadius(x, z, r) {
    const cs = this.cellSize;
    const cx0 = Math.floor(x / cs), cz0 = Math.floor(z / cs);
    const range = Math.ceil(r / cs);
    const result = [];
    const seen = new Set();
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        const bucket = this.cells.get(this._key(cx0 + dx, cz0 + dz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const seg = bucket[i];
          if (seg.name && !seen.has(seg)) { seen.add(seg); result.push(seg); }
        }
      }
    }
    return result;
  }

  // Nearest road anywhere in the grid (slow) — used once at spawn to place the car.
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

// ---- Overpass fetching --------------------------------------------------
// Download every road `way` inside a bbox. Falls back across mirrors and retries,
// because the free public endpoints regularly answer 429/504 when busy.
async function fetchRoads(bbox) {
  const cacheKey = `osm_roads_v3:${bbox}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* cache corrupt, re-fetch */ }
  }

  // Ask for road ways of the requested types, plus the nodes they reference
  // (`(._;>;)`) so each way comes back with coordinates.
  const query = `[out:json][timeout:25];way["highway"~"^(${ROAD_TYPES})$"](${bbox});(._;>;);out body;`;
  const reqBody = `data=${encodeURIComponent(query)}`;

  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(endpoint, { method: 'POST', body: reqBody });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const roads = parseOverpassRoads(await res.json());
        try { localStorage.setItem(cacheKey, JSON.stringify(roads)); }
        catch (e) { console.warn('Could not cache road data:', e); }
        return roads;
      } catch (e) {
        lastErr = e;
        console.warn(`Overpass ${endpoint} attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 700 * attempt));   // brief backoff before retry
      }
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

// Turn raw Overpass JSON (a flat list of nodes + ways) into compact road records:
// Array<{ id, name, highway, coords: Array<[lon, lat]> }>.
function parseOverpassRoads(json) {
  const nodes = new Map();
  for (const el of json.elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
  }
  const roads = [];
  for (const el of json.elements) {
    if (el.type === 'way' && el.nodes) {
      const coords = el.nodes.map(id => nodes.get(id)).filter(Boolean);
      const name = el.tags && el.tags.name ? el.tags.name : '';
      const highway = el.tags && el.tags.highway ? el.tags.highway : '';
      if (coords.length >= 2) roads.push({ id: el.id, name, highway, coords });
    }
  }
  return roads;
}

// Road class -> drawn/collision width in metres.
function roadWidth(highway) {
  if (highway === 'motorway') return 18;
  if (highway === 'trunk' || highway === 'primary') return 16;
  if (highway === 'secondary') return 12;
  if (highway === 'tertiary') return 10;
  return 8;   // residential / service / default
}

// ---- the streaming network ---------------------------------------------
// createRoadNetwork(geoToLocal, opts) owns one RoadGrid + one Path2D (the minimap
// outline) and grows both as new tiles arrive.
//
  //   network.grid       — RoadGrid for spawn placement / labels
//   network.path2D     — Path2D of every loaded road, in local metres (minimap)
//   network.ready      — true once the first tile resolves (so driving can start)
//   network.streamAround(lat, lon, wide) — call each frame; loads the nearest
//                        not-yet-loaded tile (wider lookahead when `wide`, e.g. the plane)
export function createRoadNetwork(geoToLocal, { hasMinimap = true, onFirstTile } = {}) {
  const grid = new RoadGrid(ROAD_GRID_CELL);
  const path2D = hasMinimap ? new Path2D() : null;
  const loadedTiles = new Set();   // tile keys we've already requested
  const seenWayIds = new Set();    // de-dup ways shared across adjacent tiles
  let fetchInFlight = false;        // throttle: one Overpass call at a time
  let ready = false;
  const _v = new THREE.Vector3();

  // Convert a batch of ways to local XZ and append to the grid + minimap path.
  function mergeRoads(roads) {
    for (const road of roads) {
      if (road.id != null) {
        if (seenWayIds.has(road.id)) continue;
        seenWayIds.add(road.id);
      }
      let prevX, prevZ;
      for (let i = 0; i < road.coords.length; i++) {
        const [lon, lat] = road.coords[i];
        geoToLocal(lat, lon, 0, _v);
        if (i > 0) {
          const isMajor = road.name && /^(motorway|trunk|primary|secondary|tertiary)$/.test(road.highway);
          grid.addSegment(prevX, prevZ, _v.x, _v.z, isMajor ? road.name : undefined, roadWidth(road.highway));
          if (path2D) { path2D.moveTo(prevX, prevZ); path2D.lineTo(_v.x, _v.z); }
        }
        prevX = _v.x; prevZ = _v.z;
      }
    }
  }

  function streamAround(lat, lon, wide) {
    if (fetchInFlight) return;
    const range = wide ? 2 : 1;                       // rings of tiles to keep loaded
    const tx0 = Math.floor(lon / ROAD_TILE_DEG);
    const ty0 = Math.floor(lat / ROAD_TILE_DEG);
    let target = null;
    // search outward ring by ring so the nearest tile loads first
    for (let r = 0; r <= range && !target; r++) {
      for (let dy = -r; dy <= r && !target; dy++) {
        for (let dx = -r; dx <= r && !target; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // only the ring at radius r
          const key = (tx0 + dx) + ',' + (ty0 + dy);
          if (!loadedTiles.has(key)) target = { tx: tx0 + dx, ty: ty0 + dy, key };
        }
      }
    }
    if (!target) return;                  // everything in range is already loaded
    loadedTiles.add(target.key);          // reserve now so we don't double-fetch
    fetchInFlight = true;
    const s = (target.ty * ROAD_TILE_DEG).toFixed(5);        // south (min lat)
    const w = (target.tx * ROAD_TILE_DEG).toFixed(5);        // west  (min lon)
    const n = ((target.ty + 1) * ROAD_TILE_DEG).toFixed(5);  // north (max lat)
    const e = ((target.tx + 1) * ROAD_TILE_DEG).toFixed(5);  // east  (max lon)
    fetchRoads(`${s},${w},${n},${e}`).then(roads => {
      mergeRoads(roads);
      if (!ready && onFirstTile) onFirstTile();
      ready = true;
      fetchInFlight = false;
    }).catch(err => {
      console.warn('Road tile', target.key, 'failed:', err.message);
      loadedTiles.delete(target.key);   // let it retry on a later frame
      ready = true;                      // never block driving on road availability
      fetchInFlight = false;
    });
  }

  return {
    grid,
    path2D,
    streamAround,
    get ready() { return ready; },
  };
}
