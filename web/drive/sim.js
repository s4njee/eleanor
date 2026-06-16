// sim.js — the driving simulation. This is the heart of the app and it is
// deliberately PROVIDER-AGNOSTIC: it knows nothing about Google tiles or Mapbox.
//
// It owns the canonical state of the vehicle (position, heading, speed, ...) and
// advances it each frame with a simple "bicycle" steering model. The only thing
// it needs from the outside world is the ground height under a given point —
// which the active renderer supplies as a `sampleHeight(x, z)` callback:
//
//     sampleHeight(x, z) -> { y, normal }  (or null if not known yet)
//
// Google answers it by raycasting its 3D tiles; Mapbox answers it from terrain
// elevation. Swapping engines is just swapping that one function.

import * as THREE from 'three';
import * as cfg from './config.js';

const UP = new THREE.Vector3(0, 1, 0);

export function createSim({ geo, roads, vehicles, keys }) {
  const { geoToLocal, localToGeo } = geo;
  const { carGroup, planeGroup, wheels } = vehicles;

  // ---- canonical state (the single source of truth for "where is the car") --
  const carPos = new THREE.Vector3();           // local metres; XZ driven, Y from ground
  const smoothNormal = new THREE.Vector3(0, 1, 0);
  let heading = Math.PI;                         // yaw, radians (0 = +Z / South)
  let speed = 0;                                 // m/s, positive = forward
  let steerAngle = 0;                            // current front-wheel angle, radians
  let smoothY = 0;                               // ground height, low-pass filtered
  let spawnHeading = Math.PI;
  let vehicle = 'car';                           // 'car' | 'plane'
  let driveReady = false;
  let spawnSnapped = false;
  const spawnLocal = new THREE.Vector3();
  const _geoTmp = {};

  // reusable scratch objects (avoid per-frame allocation)
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _adjFwd = new THREE.Vector3();
  const _basis = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _qBank = new THREE.Quaternion();
  const _zAxis = new THREE.Vector3(0, 0, 1);

  // Build an orientation that sits the vehicle flat on the ground (`up` = surface
  // normal) facing `forward`, then lean it into the turn by `bank` radians.
  function orientCar(forward, up, bank, group) {
    _right.crossVectors(forward, up).normalize();
    _adjFwd.crossVectors(up, _right).normalize();
    _basis.makeBasis(_right, up, _adjFwd.negate());
    _q.setFromRotationMatrix(_basis);
    _q.multiply(_qBank.setFromAxisAngle(_zAxis, bank));
    group.quaternion.slerp(_q, 0.2);   // slerp = smooth, no snapping
  }

  // Place the car at the spawn point once the vehicle and terrain are ready.
  // If roads have already streamed in, prefer the nearest road as a nicer start,
  // but roads are not required for driving.
  // Returns true the moment driving begins (so the caller can hide the loader).
  function trySpawn(sampleHeight) {
    if (driveReady || !vehicles.ready(vehicle)) return false;

    if (!spawnSnapped) {
      geoToLocal(cfg.SPAWN.lat, cfg.SPAWN.lon, 0, spawnLocal);
      if (roads.grid.cellCount > 0) {
        const nearest = roads.grid.absoluteNearest(spawnLocal.x, spawnLocal.z);
        if (nearest.dist !== Infinity) {
          spawnLocal.x = nearest.x;
          spawnLocal.z = nearest.z;
          spawnHeading = Math.atan2(nearest.dx, nearest.dz);   // face along the road
        }
      }
      spawnSnapped = true;
    }

    const ground = sampleHeight(spawnLocal.x, spawnLocal.z);
    if (!ground) return false;   // Google: wait for terrain to stream in (Mapbox never returns null)
    smoothY = ground.y;
    smoothNormal.copy(ground.normal);
    carPos.set(spawnLocal.x, smoothY, spawnLocal.z);
    heading = spawnHeading;
    driveReady = true;
    return true;
  }

  // Advance the simulation by dt seconds.
  //   sampleHeight — the active renderer's ground-probe (see top of file)
  // The car can drive anywhere the sampled surface is climbable. OSM roads are
  // only context for spawn/minimap; collision is based on obstacle height.
  function update(dt, sampleHeight) {
    // --- read inputs ---
    const wantThrottle  = keys['KeyW'] || keys['ArrowUp'];
    const wantBrake     = keys['KeyS'] || keys['ArrowDown'];
    const wantLeft      = keys['KeyA'] || keys['ArrowLeft'];
    const wantRight     = keys['KeyD'] || keys['ArrowRight'];
    const wantHandbrake = keys['Space'];

    // --- steering: ease the wheel toward the requested angle, else re-centre ---
    let steerTarget = 0;
    if (wantLeft)  steerTarget += cfg.MAX_STEER;
    if (wantRight) steerTarget -= cfg.MAX_STEER;
    if (steerTarget !== 0) {
      const dir = Math.sign(steerTarget - steerAngle);
      steerAngle += dir * cfg.STEER_SPEED * dt;
      if (dir > 0 && steerAngle > steerTarget) steerAngle = steerTarget;
      if (dir < 0 && steerAngle < steerTarget) steerAngle = steerTarget;
    } else {
      const dir = Math.sign(-steerAngle);
      steerAngle += dir * cfg.STEER_RETURN * dt;
      if (dir > 0 && steerAngle > 0) steerAngle = 0;
      if (dir < 0 && steerAngle < 0) steerAngle = 0;
    }

    // --- longitudinal speed: throttle / brake / reverse / coast ---
    if (wantHandbrake) {
      if (speed > 0) speed = Math.max(0, speed - cfg.HANDBRAKE_DECEL * dt);
      else           speed = Math.min(0, speed + cfg.HANDBRAKE_DECEL * dt);
    } else if (wantThrottle && !wantBrake) {
      if (speed < 0) {
        speed = Math.min(0, speed + cfg.BRAKE_DECEL * dt);          // brake out of reverse first
      } else {
        const maxSpeed = vehicle === 'plane' ? cfg.MAX_SPEED * 10 : cfg.MAX_SPEED;
        const accel    = vehicle === 'plane' ? cfg.ACCEL * 5      : cfg.ACCEL;
        speed = Math.min(maxSpeed, speed + accel * dt);
      }
    } else if (wantBrake && !wantThrottle) {
      if (speed > 0.5) speed = Math.max(0, speed - cfg.BRAKE_DECEL * dt);
      else             speed = Math.max(-cfg.REVERSE_MAX, speed - cfg.ACCEL * 0.5 * dt);
    } else {
      if (speed > 0) speed = Math.max(0, speed - cfg.COAST_DECEL * dt);
      else           speed = Math.min(0, speed + cfg.COAST_DECEL * dt);
    }

    // --- bicycle model: speed + steering -> change in heading ---
    if (Math.abs(speed) > 0.01) {
      heading += (speed / cfg.WHEELBASE) * Math.tan(steerAngle) * dt;
    }

    // --- integrate a tentative position (heading 0 points down +Z) ---
    const prevX = carPos.x, prevZ = carPos.z;
    carPos.x += speed * Math.sin(heading) * dt;
    carPos.z += speed * Math.cos(heading) * dt;

    // --- ground height / collision (car only; the plane flies level) ---
    // The ground probe hits the topmost surface, so driving at a building returns
    // its roof height. If that upward step is bigger than MAX_CLIMB, roll back the
    // tentative XZ move and stop; otherwise climb the surface.
    const ground = sampleHeight(carPos.x, carPos.z);
    if (ground && vehicle === 'car') {
      if (ground.y - smoothY > cfg.MAX_CLIMB) {
        carPos.x = prevX;
        carPos.z = prevZ;
        speed = 0;
      } else {
        smoothY = ground.y > smoothY ? ground.y : THREE.MathUtils.lerp(smoothY, ground.y, 0.25);
        smoothNormal.lerp(ground.normal, 0.18).normalize();
      }
    }
    if (vehicle === 'plane') {
      carPos.y = smoothY + 800;       // cruise high enough to clear skyscrapers
      smoothNormal.copy(UP);          // stay upright
    } else {
      carPos.y = smoothY + 0.05;      // sit just above the road
    }

    // --- orient + animate the active model ---
    const group = vehicle === 'car' ? carGroup : planeGroup;
    group.position.copy(carPos);
    _fwd.set(Math.sin(heading), 0, Math.cos(heading)).normalize();
    const bank = THREE.MathUtils.clamp(-steerAngle * speed * cfg.BANK_GAIN * 2, -cfg.BANK_MAX, cfg.BANK_MAX);
    orientCar(_fwd, smoothNormal, bank, group);

    if (vehicle === 'car') {
      const droll = cfg.SPIN_SIGN * (speed * dt) / cfg.WHEEL_RADIUS;
      for (const w of wheels) w.rotation.x += droll;
    }
  }

  // Snap back to the spawn point (the 'R' key).
  function reset() {
    const p = new THREE.Vector3();
    geoToLocal(cfg.SPAWN.lat, cfg.SPAWN.lon, 0, p);
    if (roads.grid.cellCount > 0) {
      const nearest = roads.grid.absoluteNearest(p.x, p.z);
      if (nearest.dist !== Infinity) { p.x = nearest.x; p.z = nearest.z; }
    }
    carPos.set(p.x, smoothY, p.z);
    heading = spawnHeading;
    speed = 0;
    steerAngle = 0;
  }

  function setVehicle(next) {
    vehicle = next;
    carGroup.visible = vehicle === 'car';
    planeGroup.visible = vehicle === 'plane';
  }

  // A renderer-friendly snapshot: local XYZ + lat/lon + pose. Renderers use this
  // to place the car on their own map without touching the sim's internals.
  function getState() {
    const g = localToGeo(carPos.x, carPos.y, carPos.z, _geoTmp);
    return {
      x: carPos.x, y: carPos.y, z: carPos.z,
      lat: g.lat, lon: g.lon,
      heading, speed, steerAngle,
    };
  }

  return {
    carPos,
    smoothNormal,
    update, trySpawn, reset, setVehicle, getState,
    get driveReady() { return driveReady; },
    get vehicle() { return vehicle; },
    get heading() { return heading; },
    get speed() { return speed; },
  };
}
