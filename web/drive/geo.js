// geo.js — the bridge between "real-world" coordinates and our 3D scene.
//
// The physics and both renderers all work in a flat local metric frame: a little
// patch of "graph paper" laid down at the spawn point, measured in metres.
//   x = East, y = Up, z = South   (Three.js convention used everywhere in this app)
//
// This module converts between that local frame and WGS84 latitude/longitude.
// It is deliberately renderer-agnostic — it does NOT depend on Google's tiles or
// Mapbox, so the simulation produces identical positions no matter which engine
// is on screen.

import * as THREE from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer/three';

const deg2rad = THREE.MathUtils.degToRad;

// createGeoFrame(spawn) returns { geoToLocal, localToGeo } anchored at `spawn`.
// "ENU" below means the standard East-North-Up frame the ellipsoid math uses.
export function createGeoFrame(spawn) {
  const _ecef = new THREE.Vector3();          // Earth-Centred-Earth-Fixed scratch
  const _base = new THREE.Matrix4();          // ENU frame at the spawn point
  const _baseInverse = new THREE.Matrix4();

  WGS84_ELLIPSOID.getEastNorthUpFrame(deg2rad(spawn.lat), deg2rad(spawn.lon), 0, _base);
  _baseInverse.copy(_base).invert();

  // lat/lon (+ height in metres) -> local scene metres, written into `target`.
  function geoToLocal(latDeg, lonDeg, height, target) {
    WGS84_ELLIPSOID.getCartographicToPosition(deg2rad(latDeg), deg2rad(lonDeg), height || 0, _ecef);
    target.copy(_ecef).applyMatrix4(_baseInverse);
    // target is now ENU: x=East, y=North, z=Up.
    // Convert to the app's Three.js frame: East=x, Up=y, South=z (= -North).
    const e = target.x, n = target.y, u = target.z;
    target.set(e, u, -n);
    return target;
  }

  // local scene metres -> lat/lon, written into `target` ({lat, lon, height}).
  function localToGeo(x, y, z, target) {
    // Three.js frame (x=East, y=Up, z=South) -> ENU (East, North=-z, Up=y) -> ECEF.
    _ecef.set(x, -z, y).applyMatrix4(_base);
    WGS84_ELLIPSOID.getPositionToCartographic(_ecef, target);
    target.lat = THREE.MathUtils.radToDeg(target.lat);
    target.lon = THREE.MathUtils.radToDeg(target.lon);
    target.height = target.height || 0;
    return target;
  }

  return { geoToLocal, localToGeo };
}
