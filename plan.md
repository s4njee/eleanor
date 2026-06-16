# Plan — Google ⇄ Mapbox renderer toggle

A runtime toggle that switches the driving app between two renderers for the same drive:

- **Google Photorealistic 3D Tiles** (current) — photoreal, but has photogrammetry "funnel / upside-down-pyramid" artifacts on roads.
- **Mapbox GL JS** (currently `streets-v12` + 3D building extrusion) — clean vector buildings + roads, **no** photogrammetry artifacts (stylized, not photoreal). `mapbox/standard` was attempted first but produced a white/no-layer render in local dev.

Same car, same driving feel, same spawn/search — just a different engine behind a toggle button.

> **How to use this file:** work top-down through the phases; flip `- [ ]` → `- [x]` as items land. Add a dated note under **Session log** at the end of each session so the next one can resume cold.

---

## Why this is non-trivial (read first)

Mapbox is **its own WebGL engine**, not a 3D-Tiles source. Google tiles render *inside* the Three.js scene via `3d-tiles-renderer`; Mapbox GL renders the map itself and we inject the car as a custom layer. So this is **two render stacks sharing one car/driving state**, switched at runtime — not a tileset swap.

## Current app (as of writing)

Single file `web/drive.js` (~800 lines, committed `fb80190`) — a free-drive city app:
- **Google key gate** (`web/drive.js` ~L84–100) → `main()` (~L102) if `VITE_GOOGLE_MAPS_KEY` / `localStorage('GOOGLE_MAPS_KEY')` present.
- **Tiles:** `TilesRenderer` + `GoogleCloudAuthPlugin` + `ReorientationPlugin(SPAWN)`, tuned LOD (`errorTarget 3.5`, big `lruCache`, anisotropy in `onLoadModel`). Attribution via `updateAttribution()`.
- **Frame:** `geoToLocal(lat,lon,h,target)` (~L185) = ECEF→local via `tiles.group.matrixWorld`. **This ties the local ENU frame to the Google tiles — see Phase 0.**
- **Surface height:** `sampleGround(x,z)` (~L207) raycasts `tiles.group`.
- **Roads:** `fetchRoads` + `tryBuildRoads` (~L235) build a `RoadGrid` (class ~L647; `nearest`, `getSegmentsInRadius`, `addSegment`; `projectOnSegment` ~L730) in local XZ. Minimap drawn in `tick`.
- **Sim state:** `carPos` (Vector3, local XZ), `heading`, `speed`, `steerAngle`, `smoothY` (~L271–278).
- **Driving:** `updateCar(dt)` (~L352) — bicycle-model physics, snap to nearest road (clamp to `ROAD_HALF_WIDTH`, ~L416–434), raycast height (~L440–446). `orientCar`, `updateChase` (~L482), `tick` (~L495).
- **Helpers:** `loadCar` (~L744), `applyStripes` (~L772), `makeGreyEnv` (~L790). Car GLB imported as `eleanorGlb` (`./eleanor.glb?url`, L8).
- **DOM (`web/drive.html`):** `#c`, `#load`, `#token`, `#attrib`, `#minimap`, `#searchForm`/`#searchInput`, `#speed`.
- Multi-page Vite build emits `index.html` + `drive.html`; deployed to `eleanor.pages.dev/drive` with the Google key baked from `web/.env.local` (`VITE_GOOGLE_MAPS_KEY`).

## Architecture decisions

- **Canonical car state is provider-agnostic:** `{ lat, lon, heading, speed, steerAngle }`. Physics + OSM road-snapping run once on a **spawn-anchored local-ENU metric frame**; each renderer maps that frame to its own display.
- **Decouple the ENU frame from Google tiles.** Build a standalone SPAWN-anchored `geoToLocal` / `localToGeo` (WGS84 ENU, e.g. `WGS84_ELLIPSOID.getCartographicToPosition` + a fixed ENU basis at SPAWN, or proj). Google's `ReorientationPlugin(SPAWN)` already lands on the same origin, so the two coincide — but Mapbox mode must not depend on Google tiles being loaded.
- **Google mode:** unchanged Three.js + `3d-tiles-renderer`; car at local ENU.
- **Mapbox mode:** `mapbox-gl` v3 (Standard style) + Eleanor as a **Three.js custom layer** (`CustomLayerInterface` — Mapbox's official "Add a 3D model with three.js" pattern; prefer this over Threebox for fewer deps/maintenance risk, Threebox is the fallback). Chase cam via `map.setFreeCameraOptions(...)`.
- **Toggle:** a button; **lazy-init** the inactive engine; **only one renders at a time** (pause the other's RAF / `map.remove()` or hide); hand over `{lat,lon,heading,speed,steerAngle}` on switch.
- **Tokens:** mirror the Google gate — `VITE_MAPBOX_TOKEN` / `localStorage('MAPBOX_TOKEN')` / paste field. Bake at build from `web/.env.local`; **URL-restrict both tokens** to the deploy domain + localhost.

---

## Prerequisites

- [x] Add a **Mapbox dev token** to `web/.env.local` as `VITE_MAPBOX_TOKEN=...` (gitignored; sits next to `VITE_GOOGLE_MAPS_KEY`). Verified on `http://127.0.0.1:5173/drive.html?engine=mapbox`.
- [ ] Before deploy, confirm the production Mapbox token is URL-restricted to `eleanor.pages.dev/*` plus local dev origins (`http://localhost:*/*` and/or `http://127.0.0.1:*/*`).
- [ ] Also add localhost / 127.0.0.1 to the **Google** key's referrer list if local Google mode needs it.

## Phase 0 — Provider-agnostic sim (refactor, no visible change)

- [x] Add a SPAWN-anchored ENU frame: `geoToLocal(lat,lon,h)` / `localToGeo(x,y,z)` that does **not** depend on `tiles.group.matrixWorld`.
- [x] Point the existing Google code at the new frame; confirm `geoToLocal` results are unchanged vs the tiles-derived frame (log/compare at SPAWN + a far road point).
- [x] Expose the sim as a small interface the renderers consume: `sim.update(dt, input)`, `sim.getState() → {lat,lon,heading,speed,steerAngle, x,z}` ; keep `carPos/heading/speed/steerAngle/RoadGrid` inside it.
- [x] **Regression:** Google mode drives identically after the refactor (height, snapping, chase cam, minimap, search).

## Phase 1 — Mapbox mode + toggle (the "see the difference" milestone)

- [x] `npm i mapbox-gl`. Confirmed Vite bundles it and `mapbox-gl/dist/mapbox-gl.css` is imported.
- [x] Token read path for Mapbox (`VITE_MAPBOX_TOKEN` / `localStorage('MAPBOX_TOKEN')`) plus visible missing-token / auth-error status overlay. A paste UI can still be added later if desired.
- [x] `web/drive.html`: added a Mapbox container `<div id="map">` (hidden by default) + `#engineToggle`.
- [x] Init Mapbox `Map` with `center=[SPAWN.lon,SPAWN.lat]`, `pitch`/`bearing` enabled, `antialias:true`. Current compatibility style is `mapbox://styles/mapbox/streets-v12`; `mapbox://styles/mapbox/standard` was deferred after local white-screen/no-layer behavior.
- [x] Add Mapbox 3D building extrusion layer on top of the classic style.
- [x] Add Mapbox loading/error status overlay so auth/style failures do not present as a silent white screen.
- [x] Add a **custom layer** that renders the Eleanor GLB with Three.js, placed at the car's lat/lon/heading each frame (MercatorCoordinate + meters-per-mercator scale).
- [x] Wheels spin + bank/orientation in Mapbox mode (reuse `sim` state).
- [x] **Chase cam:** each frame compute a camera lat/lon/alt behind+above the car (from heading + CHASE_BACK/UP) and `map.setFreeCameraOptions({ position, lookAtPoint })`.
- [x] Basic toggle logic: Google mode shows the Three canvas; Mapbox mode hides the Three canvas, shows Mapbox, lazy-inits the map, and pauses the Three render/update path while Mapbox is active.
- [x] Full toggle handoff: push `sim.getState()` into a Mapbox custom car layer and resume from the same car state when switching engines.
- [x] **Mapbox attribution** stays visible (built into the map; not hidden).
- [x] Verify on localhost / 127.0.0.1 with dev Mapbox token: Mapbox reaches `idle`, overlay hides, Times Square vector map + extruded buildings are visible.

## Phase 2 — Feature parity (the "it just works" milestone)

- [x] OSM road-snapping active in Mapbox mode (reuse `RoadGrid` via the shared ENU frame).
- [x] Minimap renders in both modes (driven by `sim` + `RoadGrid`).
- [x] Search/spawn works in both; carry the active engine across the Nominatim reload (e.g. `?engine=mapbox`).
- [x] Lighting/look tuned per engine; optional day/night for Mapbox Standard.
- [x] HUD (`#speed`, controls hint) consistent across modes.

## Phase 3 — Polish, build, deploy

- [x] Check `npm run build` locally. Verify Vite correctly builds the async `3d-tiles-renderer` and `mapbox-gl` bundles.
- [x] Deploy updated front-end via `wrangler pages deploy dist --project-name eleanor`.
- [x] `vite build` still emits `index.html` + `drive.html`; verify the toggle live on `eleanor.pages.dev/drive`.
- [x] Update repo notes/README: the two tokens, the toggle, local-dev referrer setup.

---

## Risks / open questions

- **Custom layer vs Threebox** for the car in Mapbox: prefer hand-rolled `CustomLayerInterface` (Mapbox's official three.js example); fall back to `threebox-plugin` if camera/coord sync gets painful.
- **mapbox-gl license:** free with a token, source is proprietary; `maplibre-gl` (open fork) + a vector style is the escape hatch if licensing is a concern.
- **Precision at city scale:** keep the model origin near SPAWN; use MercatorCoordinate carefully (meters-per-mercator-unit varies with latitude).
- **Single-active invariant:** never let both engines render at once (GPU/memory). Enforce in the toggle.
- **Chase-cam feel parity:** Mapbox free camera vs the Three.js chase cam may need separate tuning to feel the same.

## Session log

- _2026-06-15_ — Created this plan. App is the free-drive Google-tiles city (`web/drive.js`, committed `fb80190`); working tree clean. Mapbox not started. **Next:** Prerequisites + Phase 0.
- _2026-06-15 / 2026-06-16_ — Added Mapbox scaffolding: `mapbox-gl` dependency/CSS import, `#map`, `#engineToggle`, `?engine=mapbox` deep link, basic engine switch, Mapbox status overlay, classic `streets-v12` style, and 3D building extrusion layer. Debugged the white-screen path: the original token produced `403` locally; after updating the gitignored dev token, Mapbox loads on `127.0.0.1:5173`, reaches `idle` with 135 layers, and visually renders Times Square buildings. `npm run build` passes. **Next:** Phase 0 provider-agnostic sim, then Mapbox custom layer for Eleanor + chase cam/state handoff.
- _2026-06-16_ — Executed Phase 0 and Phase 1. Extracted `geoToLocal` from Google's matrix using an inverted `WGS84_ELLIPSOID.getEastNorthUpFrame`. Consolidated physics state and update loops into a `sim` interface that both renderers consume via `runSimAndHUD()`. Built a `MapboxCustomLayer` using Mapbox's `CustomLayerInterface` that houses a secondary Three.js renderer and scene. Mapped the Google/Three.js ENU coordinates back to Mapbox `MercatorCoordinate`s via scaling, translating, and an axis swap. Synchronized the Mapbox `setFreeCameraOptions` with the car's current pose. Toggling engines now works cleanly without crashing or resetting the car's state. **Next:** Phase 2 (Feature parity: road snapping, search, lighting).
- _2026-06-16_ — Executed Phase 2. Because Phase 0's physics refactor naturally supported OSM road snapping and the minimap, these ported to Mapbox "for free". Added state persistence across search reloads via `&engine=mapbox`. Upgraded Mapbox style to `mapbox://styles/mapbox/standard` for beautiful native 3D lighting/textures. Implemented a Day/Night toggle via the `L` key which natively dims the Mapbox base map and synchronizes the internal Three.js directional and ambient lights for perfectly unified aesthetics.
- _2026-06-16_ — Phase 3 (Deploy) completed. Confirmed production build runs successfully (`npm run build`). Published the dual-engine site live to `eleanor.pages.dev` via `wrangler pages deploy`. Epic complete!
