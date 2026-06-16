// input.js — keyboard handling, kept dumb on purpose.
//
// It does two things:
//   - `keys`        : a live map of which keys are held right now (the physics
//                     reads keys['KeyW'] etc. every frame).
//   - `on(code, fn)`: register a one-shot handler for an "action" key press
//                     (reset, free-look, day/night). The app wires those up.
//
// Typing into a text field (the search box) is ignored so WASD doesn't drive the
// car while you're searching for a city.

const DRIVING_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];

export function createInput() {
  const keys = {};
  const actions = {};   // key code -> handler fired once per keydown

  const typing = (e) => e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  addEventListener('keydown', (e) => {
    if (typing(e)) return;
    keys[e.code] = true;
    if (DRIVING_KEYS.includes(e.code)) e.preventDefault();   // stop the page scrolling
    if (actions[e.code]) actions[e.code]();
  });
  addEventListener('keyup', (e) => {
    if (typing(e)) return;
    keys[e.code] = false;
    if (DRIVING_KEYS.includes(e.code)) e.preventDefault();
  });
  // releasing focus (alt-tab etc.) should drop all held keys, or the car "sticks"
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  return {
    keys,
    on: (code, handler) => { actions[code] = handler; },
  };
}
