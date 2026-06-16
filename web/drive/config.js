// config.js — all the knobs in one place.
//
// This module has NO logic, just constants and the values we read off the URL
// and environment. Everything else imports from here, so if you want to tweak
// how fast the car accelerates, where it spawns, or which map providers we use,
// this is the only file you need to touch.

// ---- where + how we start (read from the URL query string) --------------
// e.g. /drive.html?lat=51.5&lon=-0.12&name=London&engine=mapbox
export const params = new URLSearchParams(location.search);

export const SPAWN = {
  lat: parseFloat(params.get('lat')) || 40.75800,   // default: Times Square
  lon: parseFloat(params.get('lon')) || -73.98551,
};
export const spawnName = params.get('name') || 'Times Square';

// Which renderer to boot into. 'google' = photoreal 3D tiles, 'mapbox' = vector map.
export const INITIAL_ENGINE = params.get('engine') === 'mapbox' ? 'mapbox' : 'google';

// ---- API credentials ----------------------------------------------------
// Baked in at build time from web/.env.local (VITE_*), or pasted by the user
// into localStorage. Both are public client-side tokens — restrict them by
// referrer/domain in the Google Cloud / Mapbox dashboards before shipping.
const env = import.meta.env || {};
export const GOOGLE_KEY  = env.VITE_GOOGLE_MAPS_KEY || localStorage.getItem('GOOGLE_MAPS_KEY') || '';
export const MAPBOX_TOKEN = env.VITE_MAPBOX_TOKEN   || localStorage.getItem('MAPBOX_TOKEN')   || '';

// ---- car / driving tuning ----------------------------------------------
export const WHEEL_RADIUS = 0.325;   // metres — used to match wheel spin to speed
export const SPIN_SIGN = -1;         // flip if the wheels spin backwards
export const MAX_SPEED = 30;         // m/s (~108 km/h)
export const REVERSE_MAX = 5;        // m/s
export const ACCEL = 13;             // m/s²
export const BRAKE_DECEL = 28;       // m/s² (braking is stronger than coasting)
export const COAST_DECEL = 4;        // m/s² (no input = gentle coast-down)
export const HANDBRAKE_DECEL = 45;   // m/s²

// steering (bicycle model)
export const WHEELBASE = 2.6;        // metres (front-to-rear axle)
export const MAX_STEER = 0.6;        // radians (~35°)
export const STEER_SPEED = 2.5;      // rad/s (how fast the wheel turns)
export const STEER_RETURN = 4.0;     // rad/s (how fast it re-centres when released)

// chase camera (used by both renderers, each tuned slightly differently)
export const CHASE_BACK = 7.5, CHASE_UP = 3.2, LOOK_H = 1.3, CHASE_LERP = 3.2;

// cosmetic lean into corners
export const BANK_GAIN = 0.004, BANK_MAX = 0.22;

// Max upward height step the car can climb. Small road clutter and kerbs are
// below this; buildings and other tall obstacles become blocking walls.
export const CAR_HEIGHT = 1.4;
export const MAX_CLIMB = CAR_HEIGHT * 3;

// ---- OSM road network ---------------------------------------------------
// Roads stream in one ~1 km tile at a time as the vehicle moves (see roads.js).
export const ROAD_TYPES = 'motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|living_street';

// Public Overpass mirrors. The primary endpoint frequently returns 504/429 under
// load, so fetchRoads() falls back across these (retrying each) before giving up.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const ROAD_GRID_CELL = 20;    // metres per spatial-grid cell
export const ROAD_TILE_DEG = 0.01;   // road-streaming tile size (~1.1 km of latitude)

// ---- Google tile quality / cache ----------------------------------------
// Let the tile renderer use its own traversal/load strategy, but keep the cache
// bounded to a local driving area instead of retaining thousands of city tiles.
export const GOOGLE_TILE_ERROR_TARGET = 3.5;
export const GOOGLE_TILE_CACHE_MIN_SIZE = 4000;
export const GOOGLE_TILE_CACHE_MAX_SIZE = 5000;
export const GOOGLE_TILE_CACHE_MAX_BYTES = 384 * 1024 * 1024;
export const GOOGLE_TILE_DOWNLOAD_JOBS = 10;
