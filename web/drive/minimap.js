// minimap.js — the little round street map in the corner.
//
// Every frame it redraws the loaded roads rotated so the car always points "up",
// with nearby street names labelled. It reads straight from the shared sim (car
// position + heading) and road network (the Path2D outline + grid for labels), so
// it works identically no matter which renderer is on screen.

import { projectOnSegment } from './roads.js';

const SIZE = 160;          // canvas is 160x160 (see #minimap in drive.html)
const HALF = SIZE / 2;
const SCALE = 0.2;         // 1 pixel = 5 metres
const LABEL_RADIUS = 400;  // metres — how far out we look for street names

export function createMinimap(canvas, sim, roads) {
  const ctx = canvas ? canvas.getContext('2d') : null;

  function draw() {
    if (!ctx || !roads.path2D || !sim.driveReady) return;
    const carPos = sim.carPos;
    const heading = sim.heading;
    const grid = roads.grid;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();

    // Centre on the car and rotate the world so the car faces up.
    ctx.translate(HALF, HALF);
    ctx.rotate(heading + Math.PI);
    ctx.scale(SCALE, SCALE);
    ctx.translate(-carPos.x, -carPos.z);

    // --- roads ---
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2 / SCALE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(roads.path2D);

    // --- street name labels (kept upright) ---
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // pick the closest point of each named street to the car
    const labels = new Map();
    for (const seg of grid.getSegmentsInRadius(carPos.x, carPos.z, LABEL_RADIUS)) {
      const [px, pz, dist] = projectOnSegment(carPos.x, carPos.z, seg.ax, seg.az, seg.bx, seg.bz);
      if (!labels.has(seg.name) || dist < labels.get(seg.name).dist) {
        labels.set(seg.name, { x: px, z: pz, angle: Math.atan2(seg.bz - seg.az, seg.bx - seg.ax), dist });
      }
    }
    for (const [name, label] of labels) {
      ctx.save();
      ctx.translate(label.x, label.z);
      // flip text that would otherwise render upside-down after the map rotation
      let absRot = ((heading + Math.PI + label.angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const flip = absRot > Math.PI / 2 && absRot < Math.PI * 1.5;
      ctx.rotate(label.angle + (flip ? Math.PI : 0));
      ctx.scale(1 / SCALE, 1 / SCALE);   // undo the world scale so text is pixel-sized
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4;
      ctx.fillText(name, 0, flip ? 6 : -6);
      ctx.restore();
    }

    ctx.restore();

    // --- the car marker: a fixed arrow in the centre, always pointing up ---
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.moveTo(HALF, HALF - 6);
    ctx.lineTo(HALF + 5, HALF + 4);
    ctx.lineTo(HALF, HALF + 1);
    ctx.lineTo(HALF - 5, HALF + 4);
    ctx.fill();
  }

  return { draw };
}
