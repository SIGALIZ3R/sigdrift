/** The UI's stylesheet plus the two DOM helpers every UI module shares. */

const STYLE_ELEMENT_ID = 'sigdrift-ui-styles';

/**
 * The mute button's box, in viewport units so every component (whatever its own font size) can keep clear of it.
 * 4.3vmin is 2.6em of the UI font; 44px is the minimum comfortable touch target.
 */
const MUTE_SIZE = 'clamp(44px, 4.3vmin, 88px)';
const MUTE_INSET = 'clamp(8px, 1vmin, 20px)';
/** Distance from the top of the viewport to just below the mute button. */
const MUTE_CLEARANCE = `calc(max(${MUTE_INSET}, env(safe-area-inset-top)) + ${MUTE_SIZE} + ${MUTE_INSET})`;

/**
 * Sizes are in em, off one viewport-scaled font size on `.sd-ui`, so the same layout holds from a phone to 4K.
 * `--sd-rgb` is the accent of the current component; `--sd-pop`, `--sd-flash` and `--sd-pop-in` name the keyframes
 * of the attention animations so reduced-motion and the reduced-flash setting (`.sd-calm` on the UI root) can swap them.
 */
export const UI_CSS = `
.sd-ui {
  --sd-cyan: #33f0ff;
  --sd-magenta: #ff2bd6;
  --sd-amber: #ffb62e;
  --sd-red: #ff3b5c;
  --sd-text: #eef3ff;
  --sd-dim: rgba(238, 243, 255, 0.62);
  --sd-faint: rgba(238, 243, 255, 0.14);
  --sd-ink: #03121a;
  --sd-rgb: 51, 240, 255;
  --sd-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --sd-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sd-pop: sd-pop;
  --sd-flash: sd-flash;
  --sd-pop-in: sd-pop-in;
  --sd-mult-up: sd-mult-up;
  --sd-mult-hit: sd-mult-hit;
  --sd-shard-a: sd-shard-a;
  --sd-shard-b: sd-shard-b;
  --sd-lost: sd-lost;
  --sd-fell: sd-fell;
  --sd-focus: sd-focus-glitch;
  font: 400 clamp(13px, 1.65vmin, 34px) / 1.35 var(--sd-sans);
  color: var(--sd-text);
  -webkit-font-smoothing: antialiased;
  -webkit-user-select: none;
  user-select: none;
}
.sd-ui, .sd-ui *, .sd-ui *::before, .sd-ui *::after { box-sizing: border-box; }
.sd-hidden { display: none !important; }

.sd-label {
  margin: 0;
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--sd-dim);
}
.sd-num { font-family: var(--sd-mono); font-variant-numeric: tabular-nums; }
.sd-panel {
  background: rgba(5, 7, 16, 0.76);
  border: 1px solid rgba(var(--sd-rgb), 0.55);
  box-shadow: 0 0 1.4em rgba(var(--sd-rgb), 0.16), inset 0 0 1.8em rgba(var(--sd-rgb), 0.05);
}

/* ---- HUD ---- */
.sd-hud { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
.sd-hud-top {
  position: absolute;
  top: max(0.9em, env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  gap: 0.2em;
  white-space: nowrap;
}
.sd-hud-timer {
  font-size: 2.9em;
  font-weight: 600;
  line-height: 1;
  text-shadow: 0 0 0.3em rgba(51, 240, 255, 0.55), 0 0 1.1em rgba(51, 240, 255, 0.25);
}
.sd-hud-timer.is-final { color: var(--sd-cyan); }
.sd-hud-meta { display: flex; gap: 1.2em; align-items: baseline; }
.sd-hud-cp { color: var(--sd-amber); }

.sd-hud-flash {
  position: absolute;
  top: calc(max(0.9em, env(safe-area-inset-top)) + 6.4em);
  left: 0;
  right: 0;
  display: grid;
  justify-items: center;
  gap: 0.1em;
  opacity: 0;
  color: var(--sd-amber);
  text-shadow: 0 0 0.6em rgba(255, 182, 46, 0.7);
}
.sd-hud-flash .sd-label { font-size: 0.95em; color: inherit; }
.sd-hud-flash .sd-num { font-size: 1.5em; color: var(--sd-text); }
.sd-hud-flash.is-on { animation: var(--sd-flash) 1.5s ease-out both; }

.sd-hud-centre {
  position: absolute;
  top: 34%;
  left: 0;
  right: 0;
  display: grid;
  justify-items: center;
  gap: 0.6em;
  padding: 0 1em;
  transform: translateY(-50%);
  text-align: center;
}
.sd-hud-count {
  font-size: 7em;
  font-weight: 700;
  line-height: 1;
  opacity: 0;
  color: var(--sd-amber);
  text-shadow: 0 0 0.25em rgba(255, 182, 46, 0.75), 0 0 0.9em rgba(255, 182, 46, 0.35);
}
.sd-hud-count.is-go {
  color: var(--sd-cyan);
  text-shadow: 0 0 0.25em rgba(51, 240, 255, 0.8), 0 0 0.9em rgba(51, 240, 255, 0.4);
}
.sd-hud-count.is-on { animation: var(--sd-pop) 1s ease-out both; }
.sd-hud-hint { font-size: 0.8em; line-height: 1.9; color: var(--sd-text); text-shadow: 0 0 0.5em #000, 0 0 0.2em #000; }

.sd-hud-score, .sd-hud-speed {
  position: absolute;
  bottom: max(1em, env(safe-area-inset-bottom));
  padding: 0.65em 0.9em 0.7em;
}
.sd-hud-score {
  --sd-rgb: 255, 43, 214;
  left: max(1em, env(safe-area-inset-left));
  width: 15.5em;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.sd-hud-score.is-live {
  border-color: rgb(var(--sd-rgb));
  box-shadow: 0 0 1.8em rgba(var(--sd-rgb), 0.5), inset 0 0 1.6em rgba(var(--sd-rgb), 0.14);
}
.sd-hud-score-head { display: flex; align-items: baseline; gap: 1em; padding-right: 3.6em; white-space: nowrap; }
.sd-hud-topscore { letter-spacing: 0.14em; opacity: 0.75; }
.sd-hud-score-row { display: flex; align-items: center; gap: 0.6em; margin-top: 0.1em; }
.sd-hud-points { font-size: 2.1em; font-weight: 600; line-height: 1.1; text-shadow: 0 0 0.35em rgba(255, 43, 214, 0.45); }
/* The badge sits on the panel's top right corner, grows up and out with the multiplier (--mult-scale, set on
   change) and changes colour as it heats up. */
.sd-hud-mult {
  --sd-rgb: 51, 240, 255;
  position: absolute;
  top: -0.95em;
  right: -0.55em;
  display: inline-block;
  min-width: 3.6em;
  padding: 0.12em 0.4em;
  border: 1px solid rgba(var(--sd-rgb), 0.85);
  background: linear-gradient(rgba(var(--sd-rgb), 0.14), rgba(var(--sd-rgb), 0.14)), rgba(5, 7, 16, 0.92);
  color: rgb(var(--sd-rgb));
  font-size: 1.15em;
  font-weight: 700;
  text-align: center;
  text-shadow: 0 0 0.45em rgba(var(--sd-rgb), 0.8);
  box-shadow: 0 0 0.9em rgba(var(--sd-rgb), 0.35);
  transform: scale(var(--mult-scale, 1));
  transform-origin: 100% 100%;
  transition: transform 0.18s ease-out, color 0.18s, border-color 0.18s, box-shadow 0.18s;
}
.sd-hud-mult.is-one { --sd-rgb: 238, 243, 255; opacity: 0.6; box-shadow: none; }
.sd-hud-mult.is-hot { --sd-rgb: 255, 43, 214; }
.sd-hud-mult.is-blazing { --sd-rgb: 255, 182, 46; }
.sd-hud-mult.is-up { animation: var(--sd-mult-up) 0.32s ease-out; }
/* Shatter: two halves of the lost value fly apart over the fresh x1.0. */
.sd-hud-mult.is-shatter::before, .sd-hud-mult.is-shatter::after {
  content: attr(data-shard);
  position: absolute;
  inset: 0;
  padding: inherit;
  color: var(--sd-red);
  text-shadow: 0 0 0.5em rgba(255, 59, 92, 0.9);
  pointer-events: none;
  animation: var(--sd-shard-a) 0.55s ease-out both;
}
.sd-hud-mult.is-shatter::before { clip-path: polygon(0 0, 100% 0, 100% 38%, 0 62%); }
.sd-hud-mult.is-shatter::after { clip-path: polygon(0 62%, 100% 38%, 100% 100%, 0 100%); animation-name: var(--sd-shard-b); }
.sd-hud-mult.is-shatter { animation: var(--sd-mult-hit) 0.36s steps(1, end); }
.sd-hud-prox {
  position: relative;
  height: 0.32em;
  margin: 0.55em 0 0.2em;
  background: var(--sd-faint);
}
.sd-hud-prox-fill {
  position: absolute;
  inset: 0;
  background: linear-gradient(to right, var(--sd-cyan), var(--sd-magenta) 70%, var(--sd-amber));
  box-shadow: 0 0 0.6em rgba(255, 43, 214, 0.6);
  transform: scaleX(0);
  transform-origin: 0 50%;
  transition: transform 0.08s linear;
}
.sd-hud-prox.is-close .sd-hud-prox-fill { box-shadow: 0 0 0.9em rgba(255, 43, 214, 0.85); }
.sd-hud-prox.is-razor .sd-hud-prox-fill { box-shadow: 0 0 1.1em rgba(255, 182, 46, 0.95); }
.sd-hud-callout {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.3em);
  opacity: 0;
  font-size: 0.82em;
  font-weight: 800;
  font-style: italic;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--sd-magenta);
  text-shadow: 0 0 0.6em rgba(255, 43, 214, 0.85);
}
.sd-hud-callout.is-razor { color: var(--sd-amber); text-shadow: 0 0 0.6em rgba(255, 182, 46, 0.9); }
.sd-hud-callout.is-on { animation: var(--sd-flash) 0.9s ease-out both; }
.sd-hud-combo { display: flex; justify-content: space-between; align-items: baseline; gap: 1em; transition: opacity 0.18s; }
.sd-hud-combo .sd-num { color: var(--sd-magenta); }
.sd-hud-combo.is-empty { opacity: 0.35; }
.sd-hud-lost {
  position: absolute;
  left: 0;
  bottom: calc(100% + 1.5em);
  opacity: 0;
  white-space: nowrap;
  font-size: 0.95em;
  font-weight: 800;
  color: var(--sd-red);
  text-shadow: 0 0 0.6em rgba(255, 59, 92, 0.8);
}
.sd-hud-lost.is-on { animation: var(--sd-lost) 1.3s ease-out both; }
.sd-hud-fell {
  position: absolute;
  top: 40%;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.8em;
  opacity: 0;
  font-size: 1.5em;
  font-weight: 800;
  font-style: italic;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--sd-amber);
  text-shadow: 0 0 0.6em rgba(255, 182, 46, 0.8);
}
.sd-hud-fell i { width: 1.6em; height: 2px; background: currentColor; }
.sd-hud-fell span:last-child { font-size: 0.6em; color: var(--sd-text); }
.sd-hud-fell.is-on { animation: var(--sd-fell) 0.45s steps(1, end) both; }
.sd-hud-speed {
  right: max(1em, env(safe-area-inset-right));
  display: flex;
  align-items: baseline;
  gap: 0.5em;
}
.sd-hud-speed-value { min-width: 3ch; font-size: 2.3em; font-weight: 600; line-height: 1.1; text-align: right; }

/* ---- HUD: endless mode ---- */
.sd-hud-etop { width: 15em; }
.sd-hud-level { display: flex; align-items: center; gap: 0.7em; }
.sd-hud-level .sd-label { color: var(--sd-magenta); }
.sd-hud-meter { display: flex; gap: 2px; }
.sd-hud-meter i { width: 0.4em; height: 0.78em; background: var(--sd-faint); transform: skewX(-14deg); }
.sd-hud-meter i.is-on { background: var(--sd-cyan); box-shadow: 0 0 0.5em rgba(51, 240, 255, 0.7); }
.sd-hud-meter i.is-on:nth-child(n + 4) { background: var(--sd-amber); box-shadow: 0 0 0.5em rgba(255, 182, 46, 0.7); }
.sd-hud-meter i.is-on:nth-child(n + 7) { background: var(--sd-red); box-shadow: 0 0 0.5em rgba(255, 59, 92, 0.75); }
.sd-hud-dist { display: flex; align-items: baseline; gap: 0.16em; }
.sd-hud-unit { font-size: 0.36em; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sd-dim); text-shadow: none; }
.sd-hud-lives {
  position: absolute;
  top: calc(max(0.9em, env(safe-area-inset-top)) + 1.97em);
  right: calc(50% + 8.7em);
  display: flex;
  gap: 0.5em;
}
.sd-life { position: relative; width: 1.3em; height: 1.3em; filter: drop-shadow(0 0 0.3em rgba(51, 240, 255, 0.85)); }
.sd-life i { position: absolute; inset: 0; background: var(--sd-cyan); }
.sd-life i:first-child { --sd-side: -1; clip-path: polygon(50% 0, 0 50%, 50% 100%); }
.sd-life i:last-child { --sd-side: 1; clip-path: polygon(50% 0, 100% 50%, 50% 100%); }
.sd-life.is-last { filter: drop-shadow(0 0 0.35em rgba(255, 182, 46, 0.9)); animation: sd-pulse 0.8s ease-in-out infinite; }
.sd-life.is-last i { background: var(--sd-amber); }
.sd-life.is-broken { filter: none; }
.sd-life.is-broken i {
  background: var(--sd-red);
  opacity: 0.4;
  transform: translate(calc(var(--sd-side) * 0.13em), calc(var(--sd-side) * -0.09em)) rotate(calc(var(--sd-side) * 12deg));
  animation: sd-crack 0.5s ease-out;
}
.sd-hud-flash.is-crash { color: var(--sd-red); text-shadow: 0 0 0.6em rgba(255, 59, 92, 0.75); }
.sd-hud-flash.is-crash .sd-num { font-size: 1.05em; letter-spacing: 0.12em; text-transform: uppercase; }
.sd-hud-air {
  position: absolute;
  left: 50%;
  bottom: calc(max(1em, env(safe-area-inset-bottom)) + 0.55em);
  padding-left: 0.32em;
  transform: translateX(-50%);
  opacity: 0;
  font-size: 1.7em;
  font-weight: 800;
  font-style: italic;
  line-height: 1;
  letter-spacing: 0.32em;
  color: var(--sd-cyan);
  text-shadow: 0.05em 0.05em 0 var(--sd-magenta), 0 0 0.6em rgba(51, 240, 255, 0.7);
  transition: opacity 0.1s;
}
.sd-hud-air.is-on { opacity: 1; }

/* ---- Mute button ---- */
.sd-mute {
  position: absolute;
  top: max(${MUTE_INSET}, env(safe-area-inset-top));
  right: max(${MUTE_INSET}, env(safe-area-inset-right));
  z-index: 4;
  display: grid;
  place-items: center;
  width: ${MUTE_SIZE};
  height: ${MUTE_SIZE};
  padding: 0;
  border: 1px solid rgba(var(--sd-rgb), 0.5);
  border-radius: 2px;
  background: rgba(5, 7, 16, 0.76);
  color: rgb(var(--sd-rgb));
  cursor: pointer;
  pointer-events: auto;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.12s, border-color 0.12s, box-shadow 0.12s, color 0.12s;
}
.sd-mute:hover, .sd-mute:focus-visible {
  border-color: rgb(var(--sd-rgb));
  background: rgba(var(--sd-rgb), 0.16);
  box-shadow: 0 0 1.2em rgba(var(--sd-rgb), 0.35);
}
.sd-mute:focus-visible { outline: 2px solid var(--sd-text); outline-offset: 2px; }
.sd-mute[aria-pressed="true"] { --sd-rgb: 255, 182, 46; }
.sd-mute svg { display: block; width: 54%; height: 54%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.sd-mute .sd-mute-body { fill: currentColor; stroke-width: 1.2; }
.sd-mute .sd-mute-off, .sd-mute[aria-pressed="true"] .sd-mute-on { display: none; }
.sd-mute[aria-pressed="true"] .sd-mute-off { display: inline; }

/* ---- Buttons and form controls ---- */
.sd-btn {
  padding: 0.85em 1.4em;
  border: 1px solid rgba(var(--sd-rgb), 0.5);
  border-radius: 2px;
  background: rgba(var(--sd-rgb), 0.06);
  color: var(--sd-text);
  font: 700 0.82em / 1.2 var(--sd-sans);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
}
.sd-btn:hover, .sd-btn:focus-visible {
  border-color: rgb(var(--sd-rgb));
  background: rgba(var(--sd-rgb), 0.16);
  box-shadow: 0 0 1.2em rgba(var(--sd-rgb), 0.35);
}
.sd-btn:focus-visible, .sd-range:focus-visible, .sd-switch:focus-visible {
  outline: 2px solid var(--sd-text);
  outline-offset: 2px;
}
.sd-btn-primary {
  border-color: rgb(var(--sd-rgb));
  background: rgba(var(--sd-rgb), 0.92);
  color: var(--sd-ink);
  box-shadow: 0 0 1.4em rgba(var(--sd-rgb), 0.45);
}
.sd-btn-primary:hover, .sd-btn-primary:focus-visible {
  background: rgb(var(--sd-rgb));
  box-shadow: 0 0 2.1em rgba(var(--sd-rgb), 0.75);
}
.sd-btn-small { padding: 0.55em 0.9em; }
.sd-btn[aria-pressed="true"] { border-color: rgb(var(--sd-rgb)); background: rgba(var(--sd-rgb), 0.92); color: var(--sd-ink); }
.sd-seg { display: inline-flex; }
.sd-seg .sd-btn + .sd-btn { margin-left: -1px; }
.sd-seg-wide { display: flex; }
.sd-seg-wide .sd-btn { flex: 1 1 0; padding-left: 0.3em; padding-right: 0.3em; }

.sd-range {
  -webkit-appearance: none;
  appearance: none;
  width: 9em;
  height: 1.5em;
  margin: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.sd-range::-webkit-slider-runnable-track { height: 2px; background: rgba(var(--sd-rgb), 0.45); }
.sd-range::-moz-range-track { height: 2px; background: rgba(var(--sd-rgb), 0.45); }
.sd-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 0.9em;
  height: 0.9em;
  margin-top: calc(1px - 0.45em);
  border: 0;
  border-radius: 0;
  background: rgb(var(--sd-rgb));
  box-shadow: 0 0 0.6em rgba(var(--sd-rgb), 0.75);
  transform: rotate(45deg);
}
.sd-range::-moz-range-thumb {
  width: 0.9em;
  height: 0.9em;
  border: 0;
  border-radius: 0;
  background: rgb(var(--sd-rgb));
  box-shadow: 0 0 0.6em rgba(var(--sd-rgb), 0.75);
  transform: rotate(45deg);
}
.sd-switch {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  flex: none;
  width: 2.7em;
  height: 1.35em;
  margin: 0;
  border: 1px solid rgba(var(--sd-rgb), 0.5);
  border-radius: 2px;
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.sd-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc(50% - 2px);
  background: var(--sd-dim);
  transition: transform 0.12s, background 0.12s;
}
.sd-switch:checked { border-color: rgb(var(--sd-rgb)); background: rgba(var(--sd-rgb), 0.14); }
.sd-switch:checked::after {
  background: rgb(var(--sd-rgb));
  box-shadow: 0 0 0.6em rgba(var(--sd-rgb), 0.8);
  transform: translateX(100%);
}

/* ---- Menu ---- */
.sd-menu {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: grid;
  place-items: center;
  padding: max(0.8em, env(safe-area-inset-top)) max(0.8em, env(safe-area-inset-right))
    max(0.8em, env(safe-area-inset-bottom)) max(0.8em, env(safe-area-inset-left));
  background: radial-gradient(ellipse at center, rgba(4, 5, 12, 0.5), rgba(4, 5, 12, 0.88));
  pointer-events: auto;
}
/* The frame holds the border and never scrolls, so the glitch layers drawn over it stay put; the panel inside scrolls. */
.sd-menu-frame {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(100%, 60em);
  min-height: 0;
  max-height: 100%;
  /* Faint static scanlines, behind the text. */
  background:
    repeating-linear-gradient(to bottom, rgba(var(--sd-rgb), 0.028) 0 1px, rgba(0, 0, 0, 0) 1px 3px),
    rgba(5, 7, 16, 0.94);
}
.sd-menu-frame.is-narrow { width: min(100%, 25em); }
.sd-menu-frame.is-medium { width: min(100%, 40em); }
.sd-menu-panel {
  min-height: 0;
  padding: clamp(1.1em, 4vw, 2em);
  overflow: auto;
  overscroll-behavior: contain;
}
.sd-screen { display: grid; gap: 1.5em; }
.sd-logo {
  margin: 0;
  font-size: clamp(2.5em, 11vw, 3.8em);
  font-weight: 200;
  line-height: 1;
  letter-spacing: -0.01em;
}
.sd-logo b {
  padding-right: 0.08em;
  font-weight: 800;
  font-style: italic;
  letter-spacing: 0.03em;
  color: var(--sd-cyan);
  text-shadow: 0.04em 0.04em 0 var(--sd-magenta), 0 0 0.55em rgba(51, 240, 255, 0.55);
}
.sd-tagline { margin-top: 0.7em; }
.sd-heading {
  margin: 0;
  font-size: 1.5em;
  font-weight: 700;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  text-shadow: 0 0 0.6em rgba(51, 240, 255, 0.5);
}
.sd-section { display: grid; gap: 0.6em; align-content: start; }
.sd-muted { margin: 0; font-size: 0.9em; line-height: 1.5; color: var(--sd-dim); }
.sd-dim { color: var(--sd-dim); }
.sd-strong { font-weight: 700; color: var(--sd-text); }

/* Title: no box, just the name over the city. */
.sd-menu-frame.is-bare { border-color: transparent; background: transparent; box-shadow: none; }
.sd-title { justify-items: center; gap: 1.2em; padding: 2em 0; text-align: center; }
.sd-logo-big { font-size: clamp(3.4em, 15vw, 7.5em); }
.sd-press {
  margin-top: 1.4em;
  padding: 0.8em 1.6em;
  border: 1px solid rgba(var(--sd-rgb), 0.45);
  background: rgba(5, 7, 16, 0.5);
  color: var(--sd-cyan);
  font: 700 0.9em / 1 var(--sd-mono);
  letter-spacing: 0.32em;
  text-transform: uppercase;
  cursor: pointer;
  animation: sd-breathe 1.8s ease-in-out infinite;
}
.sd-menu.is-title { cursor: pointer; }
/* With no box on the title, a box slice would draw the outline of one that is not there. */
.sd-menu-frame.is-bare.sd-g-pslice::before, .sd-menu-frame.is-bare.sd-g-pslice::after { display: none; }

/* Screen header: back button left, titles beside it. */
.sd-screen-head { display: flex; align-items: center; gap: 1em; }
.sd-screen-titles { display: grid; gap: 0.25em; min-width: 0; }
.sd-btn-back { flex: none; }
.sd-btn-back .sd-btn-label::before { content: "‹ "; }

.sd-main { justify-items: stretch; }
.sd-main .sd-logo { text-align: center; }
.sd-main-list { display: grid; gap: 0.7em; }
.sd-btn-big { padding: 1.05em 1.4em; font-size: 1em; letter-spacing: 0.28em; }
.sd-btn-ghost { border-color: transparent; background: transparent; color: var(--sd-dim); }
.sd-btn.is-disabled, .sd-btn:disabled { opacity: 0.3; cursor: default; }
.sd-btn-label { position: relative; display: inline-block; }

/* Cards: big buttons with a title, a line and a couple of numbers. */
.sd-cards { display: grid; gap: 0.9em; }
.sd-cards-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sd-cards-levels { grid-template-columns: minmax(0, 1fr); gap: 0.6em; }
.sd-cards-levels .sd-card {
  grid-template-columns: minmax(0, 13em) minmax(0, 1fr) auto;
  grid-template-areas: "t l s" "p l s";
  align-items: center;
  gap: 0.35em 1.2em;
  min-height: 0;
  padding: 0.8em 1em;
}
.sd-cards-levels .sd-card-title { grid-area: t; }
.sd-cards-levels .sd-pips { grid-area: p; }
.sd-cards-levels .sd-card-line { grid-area: l; }
.sd-cards-levels .sd-card-stats { grid-area: s; flex-wrap: nowrap; margin: 0; }
.sd-cards-levels .sd-card-stat { min-width: 5.6em; }
.sd-card-d1, .sd-card-d2 { --sd-rgb: 51, 240, 255; }
.sd-card-d3 { --sd-rgb: 255, 182, 46; }
.sd-card-d4, .sd-card-d5 { --sd-rgb: 255, 43, 214; }
.sd-card {
  position: relative;
  display: grid;
  align-content: start;
  gap: 0.6em;
  min-height: 9em;
  padding: 1.1em 1.1em 1em;
  border: 1px solid rgba(var(--sd-rgb), 0.4);
  border-left: 3px solid rgb(var(--sd-rgb));
  border-radius: 2px;
  background: linear-gradient(135deg, rgba(var(--sd-rgb), 0.1), rgba(var(--sd-rgb), 0.02) 60%);
  color: var(--sd-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, box-shadow 0.12s, transform 0.12s;
}
.sd-card-cyan { --sd-rgb: 51, 240, 255; }
.sd-card-amber, .sd-card-medium { --sd-rgb: 255, 182, 46; }
.sd-card-magenta, .sd-card-hard { --sd-rgb: 255, 43, 214; }
.sd-card-easy { --sd-rgb: 51, 240, 255; }
.sd-card:hover, .sd-card:focus { background: linear-gradient(135deg, rgba(var(--sd-rgb), 0.22), rgba(var(--sd-rgb), 0.05) 70%); }
.sd-card-title {
  font-size: 1.15em;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgb(var(--sd-rgb));
  text-shadow: 0 0 0.6em rgba(var(--sd-rgb), 0.45);
}
.sd-card-line { font-size: 0.9em; line-height: 1.45; color: var(--sd-dim); }
.sd-card-stats { display: flex; flex-wrap: wrap; gap: 0.3em 1.4em; margin-top: auto; }
.sd-card-stat { display: grid; gap: 0.1em; }
.sd-card-stat .sd-num { font-size: 1.05em; }
.sd-card.is-done .sd-pips::after {
  content: "CLEARED";
  margin-left: 0.8em;
  font-size: 0.62em;
  font-weight: 700;
  line-height: 0.8;
  letter-spacing: 0.22em;
  color: rgb(var(--sd-rgb));
}
.sd-pips { display: flex; gap: 3px; }
.sd-pips i { width: 0.75em; height: 0.5em; background: var(--sd-faint); transform: skewX(-18deg); }
.sd-pips i.is-on { background: rgb(var(--sd-rgb)); box-shadow: 0 0 0.45em rgba(var(--sd-rgb), 0.7); }

.sd-week-card { display: grid; gap: 0.8em; padding: 1em 1.1em; border-left: 3px solid var(--sd-cyan); background: rgba(51, 240, 255, 0.05); }
.sd-week-id { font-size: 2.2em; font-weight: 600; color: var(--sd-cyan); text-shadow: 0 0 0.4em rgba(51, 240, 255, 0.5); }

.sd-weeks { display: grid; }
.sd-week {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 1.4em;
  padding: 0.7em 0.8em;
  border: 0;
  border-bottom: 1px solid var(--sd-faint);
  background: transparent;
  color: var(--sd-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, box-shadow 0.12s;
}
.sd-week:hover, .sd-week:focus { background: rgba(51, 240, 255, 0.1); box-shadow: inset 3px 0 0 var(--sd-cyan); }

/* How to play */
.sd-howto-card { position: relative; display: grid; gap: 0.8em; }
.sd-howto-title { font-size: 1.9em; color: var(--sd-cyan); }
.hw-tag circle { fill: #05070f; stroke: var(--sd-text); stroke-width: 1.2; }
.hw-tag text { fill: var(--sd-text); font-size: 9px; font-weight: 700; }
.hw-tag-hot circle { stroke: var(--sd-magenta); }
.hw-tag-hot text { fill: var(--sd-magenta); }
.sd-howto-art { display: grid; place-items: center; padding: 0.4em 0; border: 1px solid var(--sd-faint); background: rgba(51, 240, 255, 0.03); }
.sd-howto-svg { display: block; width: 100%; max-width: 34em; height: auto; overflow: visible; }
.sd-howto-text { display: grid; gap: 0.4em; min-height: 4.4em; }
.sd-howto-text p { margin: 0; font-size: 1em; line-height: 1.5; }
.sd-howto-text p + p { color: var(--sd-dim); }
.sd-dots { display: flex; justify-content: center; gap: 0.5em; }
.sd-dots i { width: 1.6em; height: 3px; background: var(--sd-faint); transition: background 0.15s, box-shadow 0.15s; }
.sd-dots i.is-on { background: var(--sd-cyan); box-shadow: 0 0 0.6em rgba(51, 240, 255, 0.8); }
.sd-howto-actions { display: grid; grid-template-columns: auto 1fr auto; gap: 0.6em; }
.sd-howto-svg text { font-family: var(--sd-mono); }
.hw-key rect { fill: rgba(51, 240, 255, 0.08); stroke: var(--sd-cyan); stroke-width: 1.4; filter: drop-shadow(0 0 3px rgba(51, 240, 255, 0.6)); }
.hw-key text { fill: var(--sd-text); font-size: 15px; font-weight: 700; }
.hw-key-wide text { font-size: 12px; letter-spacing: 2px; }
.hw-or { fill: var(--sd-dim); font-size: 12px; }
.hw-cap { fill: var(--sd-text); font-size: 9.5px; letter-spacing: 1.2px; }
.hw-small { fill: var(--sd-text); font-size: 10px; }
.hw-cyan { fill: var(--sd-cyan); }
.hw-magenta { fill: var(--sd-magenta); }
.hw-amber { fill: var(--sd-amber); }
.hw-red { fill: var(--sd-red); }
.hw-dim { fill: var(--sd-dim); }
.hw-road { fill: none; stroke: rgba(238, 243, 255, 0.08); stroke-width: 44; }
.hw-trail { fill: none; stroke: var(--sd-magenta); stroke-width: 2; stroke-dasharray: 4 4; opacity: 0.8; }
.hw-car rect { fill: #0b1420; stroke: var(--sd-cyan); stroke-width: 1.5; }
.hw-car .hw-nose { fill: var(--sd-cyan); stroke: none; }
.hw-car.hw-hot rect { stroke: var(--sd-magenta); filter: drop-shadow(0 0 4px rgba(255, 43, 214, 0.8)); }
.hw-car.hw-hot .hw-nose { fill: var(--sd-magenta); }
.hw-car.hw-ghost { opacity: 0.45; }
.hw-arrow { fill: none; stroke: var(--sd-cyan); stroke-width: 2; }
.hw-tipfill { fill: var(--sd-cyan); }
.hw-wall { fill: var(--sd-cyan); filter: drop-shadow(0 0 4px rgba(51, 240, 255, 0.9)); }
.hw-p3 { fill: rgba(255, 182, 46, 0.55); }
.hw-p2 { fill: rgba(255, 43, 214, 0.35); }
.hw-p1 { fill: rgba(51, 240, 255, 0.15); }
.hw-pts { fill: var(--sd-magenta); font-size: 16px; font-weight: 700; }
.hw-badge rect { fill: rgba(51, 240, 255, 0.12); stroke: var(--sd-cyan); stroke-width: 1.4; }
.hw-badge text { fill: var(--sd-cyan); font-size: 15px; font-weight: 700; }
.hw-badge.hw-broken rect { stroke: var(--sd-red); fill: rgba(255, 59, 92, 0.1); }
.hw-badge.hw-broken text { fill: var(--sd-red); }
.hw-badge.hw-broken path { stroke: var(--sd-red); stroke-width: 2; }
.hw-badge.hw-one rect { stroke: var(--sd-text); fill: none; }
.hw-badge.hw-one text { fill: var(--sd-text); }
.hw-arrowtext { fill: var(--sd-dim); font-size: 14px; }
.hw-spark { fill: none; stroke: var(--sd-amber); stroke-width: 2; stroke-linecap: round; filter: drop-shadow(0 0 3px rgba(255, 182, 46, 0.9)); }
.hw-deck { fill: rgba(238, 243, 255, 0.07); }
.hw-hazfill { fill: var(--sd-amber); }
.hw-floor { stroke: rgba(238, 243, 255, 0.25); stroke-width: 1; stroke-dasharray: 2 3; }
.hw-fall { fill: none; stroke: var(--sd-amber); stroke-width: 2; stroke-dasharray: 3 4; }
.hw-mode > rect:first-child { fill: rgba(51, 240, 255, 0.06); stroke: var(--sd-cyan); stroke-width: 1.4; }
.hw-mode-mid > rect:first-child { fill: rgba(255, 182, 46, 0.06); stroke: var(--sd-amber); }
.hw-mode-end > rect:first-child { fill: rgba(255, 43, 214, 0.06); stroke: var(--sd-magenta); }
.hw-cal { fill: none; stroke: var(--sd-cyan); stroke-width: 1.4; }
.hw-pip { fill: rgba(238, 243, 255, 0.14); }
.hw-pip.on { fill: var(--sd-amber); }
.hw-inf { fill: var(--sd-magenta); font-size: 44px; }

/* Tables: controls and high scores. */
.sd-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.sd-table th, .sd-table td { padding: 0.45em 0.6em 0.45em 0; border-bottom: 1px solid var(--sd-faint); text-align: left; }
.sd-table th { font-size: 0.78em; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--sd-dim); }
.sd-controls td:first-child { color: var(--sd-dim); }
.sd-scores td { font-family: var(--sd-mono); font-variant-numeric: tabular-nums; }
.sd-scores td:first-child { width: 2em; color: var(--sd-dim); }
.sd-scores td:last-child { color: var(--sd-dim); }
.sd-scores tr.is-new td { color: var(--sd-ink); background: rgba(255, 43, 214, 0.85); }
.sd-scores tr.is-new td:first-child { padding-left: 0.4em; }
.sd-scores tr.is-new { box-shadow: 0 0 1.2em rgba(255, 43, 214, 0.55); }
.sd-rank { font-family: var(--sd-mono); letter-spacing: 0.08em; color: var(--sd-magenta); }
.sd-badges { display: flex; flex-wrap: wrap; gap: 0.5em; }
.sd-badges:empty { display: none; }
.sd-badge.sd-badge-cyan { border-color: var(--sd-cyan); box-shadow: 0 0 1.2em rgba(51, 240, 255, 0.55), inset 0 0 0.9em rgba(51, 240, 255, 0.3); }
.sd-actions-row { grid-template-columns: repeat(auto-fit, minmax(7em, 1fr)); }

.sd-settings { display: grid; gap: 0.2em; }
.sd-setting { display: flex; align-items: center; justify-content: space-between; gap: 1em; min-height: 2.3em; font-size: 0.92em; }
.sd-setting-control { display: flex; align-items: center; gap: 0.7em; }
.sd-setting-control .sd-num { min-width: 4ch; text-align: right; color: var(--sd-dim); }
.sd-setting-control { transition: opacity 0.12s; }
.sd-setting.is-off .sd-setting-control { opacity: 0.35; }
label.sd-setting { cursor: pointer; }

.sd-actions { display: grid; gap: 0.65em; }
.sd-finish-head { display: grid; gap: 0.3em; }
.sd-finish-time { font-size: clamp(2.4em, 13vw, 3.3em); font-weight: 600; line-height: 1.1; text-shadow: 0 0 0.35em rgba(51, 240, 255, 0.5); }
.sd-badge {
  padding: 0.35em 0.7em;
  border: 1px solid var(--sd-magenta);
  color: var(--sd-text);
  font-size: 0.72em;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  box-shadow: 0 0 1.2em rgba(255, 43, 214, 0.55), inset 0 0 0.9em rgba(255, 43, 214, 0.3);
  animation: var(--sd-pop-in) 0.5s ease-out both;
}
.sd-badge-muted { border-color: var(--sd-amber); box-shadow: none; letter-spacing: 0.14em; }
.sd-over { display: grid; gap: 0.45em; }
.sd-over-title {
  margin: 0;
  font-size: clamp(1.5em, 8.4vw, 2em);
  font-weight: 800;
  font-style: italic;
  line-height: 1.05;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sd-red);
  text-shadow: 0 0 0.5em rgba(255, 59, 92, 0.55);
}
.sd-over-title.is-off-road { color: var(--sd-amber); text-shadow: 0 0 0.5em rgba(255, 182, 46, 0.55); }
.sd-delta.is-faster { color: var(--sd-cyan); }
.sd-delta.is-slower { color: var(--sd-amber); }
.sd-stats { display: grid; margin: 0; }
.sd-stat { display: flex; justify-content: space-between; align-items: baseline; gap: 1em; padding: 0.45em 0; border-bottom: 1px solid var(--sd-faint); }
.sd-stat dd { margin: 0; }

/* ---- Tuning panel ---- */
.sd-tune {
  position: absolute;
  top: ${MUTE_CLEARANCE};
  right: max(0.7em, env(safe-area-inset-right));
  bottom: max(0.7em, env(safe-area-inset-bottom));
  z-index: 2;
  display: flex;
  flex-direction: column;
  width: min(25em, calc(100% - 1.4em));
  background: rgba(5, 7, 16, 0.94);
  font-size: clamp(11px, 1.25vmin, 26px);
  pointer-events: auto;
}
.sd-tune-head { display: grid; gap: 0.6em; padding: 0.8em 0.9em; border-bottom: 1px solid var(--sd-faint); }
.sd-tune-telemetry { display: grid; grid-template-columns: 1fr 1fr; gap: 0.15em 1.2em; margin: 0; }
.sd-tune-telemetry div { display: flex; justify-content: space-between; gap: 0.6em; }
.sd-tune-telemetry dt { color: var(--sd-dim); }
.sd-tune-telemetry dd { margin: 0; }
.sd-tune-actions { display: flex; gap: 0.5em; }
.sd-tune-actions .sd-btn { flex: 1; }
.sd-tune-body { flex: 1; min-height: 0; padding: 0.3em 0.9em 0.9em; overflow: auto; overscroll-behavior: contain; }
.sd-tune-group { margin: 1em 0 0.3em; color: var(--sd-cyan); }
.sd-tune-row { display: grid; grid-template-columns: minmax(0, 1fr) 8.5em 4.6em; align-items: center; gap: 0.6em; }
.sd-tune-row span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-tune-row .sd-range { width: 100%; }
.sd-tune-row .sd-num { text-align: right; }

/* ---- Motion ---- */
@keyframes sd-pop {
  0% { opacity: 0; transform: scale(1.6); }
  14% { opacity: 1; transform: scale(1); }
  70% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.9); }
}
@keyframes sd-flash {
  0% { opacity: 0; transform: translateY(0.5em) scale(1.08); }
  12% { opacity: 1; transform: none; }
  72% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sd-fade {
  0% { opacity: 0; }
  14% { opacity: 1; }
  72% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sd-pop-in {
  0% { opacity: 0; transform: scale(1.5); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes sd-fade-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
/* A life pip breaking: both halves flash white, then fall into the split, dimmed pose its rule describes. */
@keyframes sd-crack {
  0% { background: #fff; opacity: 1; transform: scale(1.4); }
  30% { background: #fff; opacity: 1; transform: scale(1.1); }
}
@keyframes sd-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.8); }
}
/* ---- Glitch bursts ---- */
/* glitch.ts puts sd-g and one sd-g-* class on an element for a fraction of a second, with --g-* numbers of its own
   each time. Only transform, opacity, clip-path and filter are animated, so nothing is laid out again or moves. */
.sd-ui [data-text] { position: relative; }
.sd-logo [data-text] { display: inline-block; }
/* What a displaced strip of text is painted on: the surface under it, so the strip hides the text it came from. */
.sd-btn-primary { --g-bg: rgb(var(--sd-rgb)); }

/* 1. RGB split: magenta and cyan ghosts either side, jumping between three offsets. */
.sd-g-rgb { animation: sd-g-rgb var(--g-dur, 140ms) steps(1, end); }
@keyframes sd-g-rgb {
  0% {
    filter: drop-shadow(var(--g-x) 0 0 rgba(255, 43, 214, 0.8)) drop-shadow(calc(var(--g-x) * -1) 0 0 rgba(51, 240, 255, 0.8));
  }
  35% {
    filter: drop-shadow(calc(var(--g-x) * -0.6) var(--g-y, 0px) 0 rgba(255, 43, 214, 0.8))
      drop-shadow(calc(var(--g-x) * 0.6) 0 0 rgba(51, 240, 255, 0.8));
  }
  65% {
    filter: drop-shadow(calc(var(--g-x) * 0.35) 0 0 rgba(255, 43, 214, 0.8))
      drop-shadow(calc(var(--g-x) * -0.35) calc(var(--g-y, 0px) * -1) 0 rgba(51, 240, 255, 0.8));
  }
  100% { filter: none; }
}

/* 2a. Slice, text: two copies of the text (from data-text) over the original, each cut to bands and pushed aside. */
.sd-g-slice[data-text]::before, .sd-g-slice[data-text]::after,
.sd-g-slice > [data-text]::before, .sd-g-slice > [data-text]::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  /* As wide as the text and no wider, or a strip would run on across the panel. */
  inset: 0 auto 0 0;
  padding: inherit;
  white-space: nowrap;
  background: var(--g-bg, #05070f);
  pointer-events: none;
  animation: sd-g-shift var(--g-dur, 180ms) steps(1, end) both;
}
.sd-btn.sd-g-slice::before, .sd-btn.sd-g-slice::after { inset: 0; }
.sd-g-slice[data-text]::before, .sd-g-slice > [data-text]::before {
  --g-sx: var(--g-x1);
  clip-path: inset(var(--g-t1) -1em calc(100% - var(--g-u1)) -1em);
}
.sd-g-slice[data-text]::after, .sd-g-slice > [data-text]::after {
  --g-sx: var(--g-x2);
  clip-path: polygon(
    -1em var(--g-t2), calc(100% + 1em) var(--g-t2), calc(100% + 1em) var(--g-u2), -1em var(--g-u2),
    -1em var(--g-t3), calc(100% + 1em) var(--g-t3), calc(100% + 1em) var(--g-u3), -1em var(--g-u3)
  );
}
@keyframes sd-g-shift {
  0% { transform: translateX(var(--g-sx)); }
  45% { transform: translateX(calc(var(--g-sx) * -0.55)); }
  75% { transform: translateX(calc(var(--g-sx) * 0.3)); }
  100% { transform: translateX(calc(var(--g-sx) * 0.3)); opacity: 0; }
}

/* 2b. Slice, boxes: the outline is notched where a band has moved away, and a ghost of its edges shows where to. */
.sd-g-pslice { animation: sd-g-notch var(--g-dur, 180ms) steps(1, end); }
.sd-g-pslice::before, .sd-g-pslice::after {
  content: "";
  position: absolute;
  inset: -1px;
  border: solid rgba(var(--sd-rgb), 0.85);
  border-width: 0 1px;
  background: rgba(var(--sd-rgb), 0.05);
  pointer-events: none;
  animation: sd-g-ghost var(--g-dur, 180ms) steps(1, end) both;
}
.sd-g-pslice::before { --g-sx: var(--g-px); clip-path: var(--g-bands-r); }
.sd-g-pslice::after { --g-sx: calc(var(--g-px) * -1); clip-path: var(--g-bands-l); }
@keyframes sd-g-notch {
  0% { clip-path: var(--g-clip); }
  55% { clip-path: var(--g-clip2); }
  85%, 100% { clip-path: none; }
}
@keyframes sd-g-ghost {
  0% { transform: translateX(var(--g-sx)); }
  55% { transform: translateX(calc(var(--g-sx) * 0.4)); }
  85%, 100% { transform: none; opacity: 0; }
}

/* 3. Flicker: a failing tube. Two or three dips, never more, and never a whole menu panel. */
.sd-g-flicker { animation: var(--g-name, sd-g-flicker-2) var(--g-dur, 140ms) steps(1, end); }
@keyframes sd-g-flicker-2 {
  0% { opacity: var(--g-dip, 0.7); }
  22% { opacity: 1; }
  48% { opacity: var(--g-dip2, 0.7); }
  68%, 100% { opacity: 1; }
}
@keyframes sd-g-flicker-3 {
  0% { opacity: var(--g-dip, 0.6); }
  14% { opacity: 1; }
  34% { opacity: var(--g-dip2, 0.6); }
  50% { opacity: 1; }
  72% { opacity: var(--g-dip, 0.6); }
  86%, 100% { opacity: 1; }
}

/* 4. Scanline: one thin line with a short trail, top to bottom, once. */
.sd-g-scan::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom, rgba(var(--sd-rgb), 0), rgba(var(--sd-rgb), 0.16) calc(100% - 2px), rgb(var(--sd-rgb)) calc(100% - 2px))
    0 0 / 100% 0.7em no-repeat;
  pointer-events: none;
  animation: sd-g-scan var(--g-dur, 260ms) linear both;
}
@keyframes sd-g-scan {
  0% { transform: translateY(-0.7em); opacity: var(--g-a, 0.8); }
  88% { opacity: var(--g-a, 0.8); }
  100% { transform: translateY(calc(100% - 0.7em)); opacity: 0; }
}

/* 5. Skew jolt: a small snap sideways and back. */
.sd-g-skew { animation: sd-g-skew var(--g-dur, 120ms) steps(1, end); }
@keyframes sd-g-skew {
  0% { transform: translateX(var(--g-x)) skewX(var(--g-skew)); }
  40% { transform: translateX(calc(var(--g-x) * -0.5)) skewX(calc(var(--g-skew) * -0.4)); }
  70%, 100% { transform: none; }
}

/* ---- Menu focus: always visible, with a short RGB glitch as it lands ---- */
.sd-menu .sd-btn:focus, .sd-menu .sd-card:focus, .sd-menu .sd-week:focus, .sd-menu .sd-press:focus,
.sd-menu .sd-switch:focus, .sd-menu .sd-range:focus {
  outline: 2px solid rgb(var(--sd-rgb));
  outline-offset: 3px;
  box-shadow: 0 0 0 1px rgba(5, 7, 16, 0.9), 0 0 1.6em rgba(var(--sd-rgb), 0.55);
}
.sd-menu .sd-btn-primary:focus { outline-color: var(--sd-text); }
.sd-menu .sd-card:focus { border-color: rgb(var(--sd-rgb)); transform: translateY(-2px); }
.sd-menu :is(.sd-btn, .sd-card, .sd-week):focus:not(.sd-g) { animation: var(--sd-focus) 0.2s steps(1, end); }
.sd-menu .sd-press:focus:not(.sd-g) { animation: var(--sd-focus) 0.2s steps(1, end), sd-breathe 1.8s ease-in-out 0.2s infinite; }
@keyframes sd-focus-glitch {
  0% { filter: drop-shadow(3px 0 0 rgba(255, 43, 214, 0.85)) drop-shadow(-3px 0 0 rgba(51, 240, 255, 0.85)); }
  35% { filter: drop-shadow(-2px 1px 0 rgba(255, 43, 214, 0.8)) drop-shadow(2px 0 0 rgba(51, 240, 255, 0.8)); }
  70% { filter: drop-shadow(1px 0 0 rgba(255, 43, 214, 0.7)) drop-shadow(-1px -1px 0 rgba(51, 240, 255, 0.7)); }
  100% { filter: none; }
}

/* ---- Menu atmosphere: static scanlines and a vignette over everything, and one faint band rolling down ---- */
.sd-menu::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.18) 0 1px, rgba(0, 0, 0, 0) 1px 3px),
    radial-gradient(ellipse at center, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, 0.6) 100%);
}
.sd-menu::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 18vh;
  z-index: 2;
  pointer-events: none;
  background: linear-gradient(to bottom, rgba(51, 240, 255, 0), rgba(51, 240, 255, 0.035) 70%, rgba(51, 240, 255, 0));
  animation: sd-roll 7s linear infinite;
}
@keyframes sd-roll {
  0% { transform: translateY(-18vh); }
  100% { transform: translateY(100vh); }
}
@keyframes sd-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

/* ---- Scramble: the real text turns transparent and the glyphs are drawn over it (no layout change) ---- */
.sd-scr { position: relative; -webkit-text-fill-color: transparent; text-shadow: none !important; }
.sd-scr::after {
  content: attr(data-scr);
  content: attr(data-scr) / "";
  position: absolute;
  inset: 0;
  padding: inherit;
  white-space: pre;
  -webkit-text-fill-color: currentColor;
  font-family: inherit;
  text-shadow: 0 0 0.4em rgba(51, 240, 255, 0.6);
  pointer-events: none;
}

/* ---- Screen transition: RGB split settling, a band-by-band reveal and one scanline sweeping down ---- */
.sd-tx-sweep { position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; }
.sd-tx-sweep::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: -3em;
  height: 3em;
  opacity: 0;
  background: linear-gradient(to bottom, rgba(51, 240, 255, 0), rgba(51, 240, 255, 0.16) calc(100% - 2px), rgba(51, 240, 255, 0.95) calc(100% - 2px));
}
.sd-menu-frame.sd-tx > .sd-tx-sweep::before { animation: sd-tx-sweep var(--tx-dur, 220ms) linear both; }
.sd-menu-frame.sd-tx > .sd-menu-panel, .sd-howto-card.sd-tx {
  animation: sd-tx-reveal var(--tx-dur, 220ms) ease-out both, sd-tx-jitter var(--tx-dur, 220ms) steps(1, end) both;
}
@keyframes sd-tx-reveal {
  0% { opacity: 0.3; clip-path: inset(var(--tx-t, 40%) 0 var(--tx-b, 45%) 0); }
  35% { opacity: 1; clip-path: inset(0 0 48% 0); }
  62% { clip-path: inset(20% 0 0 0); }
  82% { clip-path: inset(0); }
  100% { opacity: 1; clip-path: none; }
}
@keyframes sd-tx-jitter {
  0% {
    transform: translateX(var(--tx-x, 6px));
    filter: drop-shadow(var(--tx-x, 6px) 0 0 rgba(255, 43, 214, 0.85)) drop-shadow(calc(var(--tx-x, 6px) * -1) 0 0 rgba(51, 240, 255, 0.85));
  }
  30% {
    transform: translateX(calc(var(--tx-x, 6px) * -0.5));
    filter: drop-shadow(calc(var(--tx-x, 6px) * -0.6) 0 0 rgba(255, 43, 214, 0.8)) drop-shadow(calc(var(--tx-x, 6px) * 0.6) 0 0 rgba(51, 240, 255, 0.8));
  }
  60% {
    transform: translateX(calc(var(--tx-x, 6px) * 0.2));
    filter: drop-shadow(calc(var(--tx-x, 6px) * 0.3) 0 0 rgba(255, 43, 214, 0.7)) drop-shadow(calc(var(--tx-x, 6px) * -0.3) 0 0 rgba(51, 240, 255, 0.7));
  }
  85%, 100% { transform: none; filter: none; }
}
@keyframes sd-tx-sweep {
  0% { top: -3em; opacity: 1; }
  88% { opacity: 1; }
  100% { top: 100%; opacity: 0; }
}

/* ---- Signal loss: every 6-10 s the title logo tears sideways and its colours swing round ---- */
.sd-logo.sd-sigloss { animation: sd-sigloss var(--sl-dur, 440ms) steps(1, end); }
.sd-logo.sd-sigloss > [data-text]::before, .sd-logo.sd-sigloss > [data-text]::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  animation: sd-sigloss-tear var(--sl-dur, 440ms) steps(1, end) both;
}
.sd-logo.sd-sigloss > [data-text]::before { --g-sx: var(--sl-x, 14px); clip-path: inset(var(--sl-t1, 20%) -1em calc(100% - var(--sl-u1, 40%)) -1em); }
.sd-logo.sd-sigloss > [data-text]::after {
  --g-sx: calc(var(--sl-x, 14px) * -0.6);
  clip-path: inset(var(--sl-t2, 60%) -1em calc(100% - var(--sl-u2, 80%)) -1em);
  color: var(--sd-magenta);
}
@keyframes sd-sigloss {
  0% { filter: hue-rotate(var(--sl-hue, 120deg)) drop-shadow(var(--sl-x, 14px) 0 0 rgba(255, 43, 214, 0.75)); transform: skewX(-5deg); }
  22% { filter: hue-rotate(calc(var(--sl-hue, 120deg) * -0.5)) drop-shadow(calc(var(--sl-x, 14px) * -0.5) 0 0 rgba(51, 240, 255, 0.8)); transform: translateX(calc(var(--sl-x, 14px) * -0.3)); }
  48% { filter: hue-rotate(var(--sl-hue, 120deg)); transform: none; }
  70% { filter: drop-shadow(calc(var(--sl-x, 14px) * 0.25) 0 0 rgba(255, 43, 214, 0.7)); transform: skewX(2deg); }
  100% { filter: none; transform: none; }
}
@keyframes sd-sigloss-tear {
  0% { transform: translateX(var(--g-sx)); }
  30% { transform: translateX(calc(var(--g-sx) * -0.7)); }
  60% { transform: translateX(calc(var(--g-sx) * 0.4)); }
  85%, 100% { transform: none; opacity: 0; }
}

/* ---- HUD score animations ---- */
@keyframes sd-mult-up {
  0% { transform: scale(calc(var(--mult-scale, 1) * 1.35)); }
  100% { transform: scale(var(--mult-scale, 1)); }
}
@keyframes sd-mult-hit {
  0% { transform: translateX(-4px) scale(1.2); filter: drop-shadow(3px 0 0 rgba(255, 59, 92, 0.9)) drop-shadow(-3px 0 0 rgba(51, 240, 255, 0.8)); }
  30% { transform: translateX(3px) scale(1.1); filter: drop-shadow(-2px 0 0 rgba(255, 59, 92, 0.9)); }
  60%, 100% { transform: scale(var(--mult-scale, 1)); filter: none; }
}
@keyframes sd-shard-a {
  0% { transform: none; opacity: 1; }
  100% { transform: translate(-0.7em, -0.9em) rotate(-16deg); opacity: 0; }
}
@keyframes sd-shard-b {
  0% { transform: none; opacity: 1; }
  100% { transform: translate(0.8em, 0.8em) rotate(13deg); opacity: 0; }
}
@keyframes sd-fade-out {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sd-lost {
  0% { opacity: 0; transform: translateX(-5px) skewX(-14deg); }
  8% { opacity: 1; transform: translateX(4px) skewX(6deg); }
  16% { transform: none; }
  75% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes sd-fell {
  0% { opacity: 0.3; transform: translateX(-8px) skewX(-10deg); }
  30% { opacity: 1; transform: translateX(5px); }
  60%, 100% { opacity: 1; transform: none; }
}

.sd-calm .sd-ui {
  --sd-pop: sd-fade; --sd-flash: sd-fade; --sd-pop-in: sd-fade-in;
  --sd-mult-up: none; --sd-mult-hit: none; --sd-shard-a: sd-fade-out; --sd-shard-b: sd-fade-out;
  --sd-lost: sd-fade; --sd-fell: sd-fade-in; --sd-focus: none;
}
.sd-calm .sd-menu::before { display: none; }
.sd-calm .sd-press, .sd-calm .sd-menu .sd-press:focus:not(.sd-g) { animation: none; }
.sd-calm .sd-scr { -webkit-text-fill-color: currentColor; }
.sd-calm .sd-scr::after { content: none; }
/* Calm mode keeps a plain, short fade between screens. */
.sd-calm .sd-menu-frame.sd-tx > .sd-menu-panel, .sd-calm .sd-howto-card.sd-tx { animation: sd-fade-in 0.16s ease-out both; }
.sd-calm .sd-tx > .sd-tx-sweep::before { animation: none; }
.sd-calm .sd-hud-score.is-live { box-shadow: 0 0 1.4em rgba(var(--sd-rgb), 0.16); }
.sd-calm .sd-life.is-last, .sd-calm .sd-life.is-broken i { animation: none; }
/* The glitcher schedules nothing in either case; this is for a burst caught in flight by the switch. */
.sd-calm .sd-g { animation: none !important; }
.sd-calm .sd-g::before, .sd-calm .sd-g::after,
.sd-calm .sd-g > [data-text]::before, .sd-calm .sd-g > [data-text]::after { content: none !important; animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .sd-ui {
    --sd-pop: sd-fade; --sd-flash: sd-fade; --sd-pop-in: sd-fade-in;
    --sd-mult-up: none; --sd-mult-hit: none; --sd-shard-a: sd-fade-out; --sd-shard-b: sd-fade-out;
    --sd-lost: sd-fade; --sd-fell: sd-fade-in; --sd-focus: none;
  }
  .sd-menu::before { display: none; }
  .sd-press { animation: none !important; }
  .sd-scr { -webkit-text-fill-color: currentColor; }
  .sd-scr::after { content: none; }
  .sd-tx > .sd-menu-panel, .sd-howto-card.sd-tx, .sd-tx > .sd-tx-sweep::before { animation: none !important; }
  .sd-ui, .sd-ui *, .sd-ui *::before, .sd-ui *::after { transition: none !important; }
  .sd-life.is-last, .sd-life.is-broken i { animation: none; }
  .sd-g { animation: none !important; }
  .sd-g::before, .sd-g::after, .sd-g > [data-text]::before, .sd-g > [data-text]::after { content: none !important; animation: none !important; }
}
@media (max-width: 760px) {
  .sd-cards-3 { grid-template-columns: minmax(0, 1fr); }
  .sd-cards-levels .sd-card { grid-template-columns: minmax(0, 1fr); grid-template-areas: "t" "p" "l" "s"; }
  .sd-cards-levels .sd-card-stats { flex-wrap: wrap; }
  .sd-card { min-height: 0; }
  .sd-week { grid-template-columns: 1fr auto; }
  .sd-week span:last-child { display: none; }
}
/* Too narrow for the life pips to sit beside the distance: they keep to the left edge instead. */
@media (max-width: 440px) {
  .sd-hud-lives { right: auto; left: max(0.6em, env(safe-area-inset-left)); gap: 0.4em; }
}
/* Too narrow for "AIR" to fit between the drift and speed panels: it rides above them. */
@media (max-width: 560px) {
  .sd-hud-air { bottom: calc(max(1em, env(safe-area-inset-bottom)) + 4.6em); }
}
/* Where a menu panel can reach the top right corner, it starts below the mute button instead of under it. */
@media (max-width: 960px), (max-aspect-ratio: 5/4) {
  .sd-menu { padding-top: ${MUTE_CLEARANCE}; }
}
`;

/** Adds the stylesheet to the document once, however many UI modules ask for it. */
export function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = UI_CSS;
  document.head.appendChild(style);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Restarts the CSS animation tied to the `is-on` class. */
export function replayAnimation(node: HTMLElement): void {
  node.classList.remove('is-on');
  // Reading layout between the two class changes is what makes the browser treat it as a new animation.
  void node.offsetWidth;
  node.classList.add('is-on');
}
