/** The UI's stylesheet plus the two DOM helpers every UI module shares. */

const STYLE_ELEMENT_ID = 'sigdrift-ui-styles';

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

.sd-hud-drift, .sd-hud-speed {
  position: absolute;
  bottom: max(1em, env(safe-area-inset-bottom));
  padding: 0.65em 0.9em 0.7em;
}
.sd-hud-drift {
  --sd-rgb: 255, 43, 214;
  left: max(1em, env(safe-area-inset-left));
  min-width: 11em;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.sd-hud-drift.is-live {
  border-color: rgb(var(--sd-rgb));
  box-shadow: 0 0 1.8em rgba(var(--sd-rgb), 0.5), inset 0 0 1.6em rgba(var(--sd-rgb), 0.14);
}
.sd-hud-chain { display: flex; align-items: baseline; gap: 0.55em; transition: opacity 0.18s; }
.sd-hud-chain.is-empty { opacity: 0.45; }
.sd-hud-chain-pts { font-size: 1.9em; font-weight: 600; line-height: 1.15; }
.sd-hud-mult { font-size: 1.1em; color: var(--sd-magenta); }
.sd-hud-bank {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1em;
  margin-top: 0.35em;
  padding-top: 0.35em;
  border-top: 1px solid var(--sd-faint);
}
.sd-hud-lost {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.55em);
  opacity: 0;
  white-space: nowrap;
  font-size: 0.85em;
  color: var(--sd-amber);
  text-shadow: 0 0 0.6em rgba(255, 182, 46, 0.7);
}
.sd-hud-lost.is-on { animation: var(--sd-flash) 1.2s ease-out both; }
.sd-hud-speed {
  right: max(1em, env(safe-area-inset-right));
  display: flex;
  align-items: baseline;
  gap: 0.5em;
}
.sd-hud-speed-value { min-width: 3ch; font-size: 2.3em; font-weight: 600; line-height: 1.1; text-align: right; }

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
.sd-btn:focus-visible, .sd-week:focus-visible, .sd-range:focus-visible, .sd-switch:focus-visible {
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
.sd-menu-panel {
  width: min(100%, 60em);
  max-height: 100%;
  padding: clamp(1.1em, 4vw, 2em);
  background: rgba(5, 7, 16, 0.94);
  overflow: auto;
  overscroll-behavior: contain;
}
.sd-menu-panel.is-narrow { width: min(100%, 25em); }
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
.sd-title-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 1.6em 2em; }
.sd-col { display: grid; gap: 1.5em; align-content: start; }
.sd-section { display: grid; gap: 0.6em; align-content: start; }
.sd-feature { padding: 1em 1.1em; border-left: 2px solid var(--sd-cyan); background: rgba(51, 240, 255, 0.05); }
.sd-feature > .sd-label { color: var(--sd-cyan); }
.sd-feature-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 0.9em 1.2em; }
.sd-feature-time { font-size: 1.9em; font-weight: 600; line-height: 1.15; }
.sd-feature .sd-btn { flex: 1 0 auto; padding: 1em 2.4em; font-size: 0.95em; }

.sd-weeks { display: grid; max-height: 13.5em; overflow: auto; overscroll-behavior: contain; }
.sd-week {
  display: flex;
  justify-content: space-between;
  gap: 1em;
  padding: 0.55em 0.7em;
  border: 0;
  border-bottom: 1px solid var(--sd-faint);
  background: transparent;
  color: var(--sd-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, box-shadow 0.12s;
}
.sd-week:hover, .sd-week:focus-visible { background: rgba(51, 240, 255, 0.1); box-shadow: inset 2px 0 0 var(--sd-cyan); }
.sd-week .sd-num:last-child { color: var(--sd-dim); }

.sd-controls { width: 100%; border-collapse: collapse; font-size: 0.86em; }
.sd-controls th, .sd-controls td { padding: 0.36em 0.6em 0.36em 0; border-bottom: 1px solid var(--sd-faint); text-align: left; }
.sd-controls th { font-size: 0.82em; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--sd-dim); }
.sd-controls td:first-child { color: var(--sd-dim); }

.sd-setting { display: flex; align-items: center; justify-content: space-between; gap: 1em; min-height: 2.3em; font-size: 0.92em; }
.sd-setting-control { display: flex; align-items: center; gap: 0.7em; }
.sd-setting-control .sd-num { min-width: 4ch; text-align: right; color: var(--sd-dim); }
label.sd-setting { cursor: pointer; }

.sd-actions { display: grid; gap: 0.65em; }
.sd-finish-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.6em; }
.sd-finish-time { font-size: clamp(2.4em, 13vw, 3.3em); font-weight: 600; line-height: 1.1; text-shadow: 0 0 0.35em rgba(51, 240, 255, 0.5); }
.sd-badge {
  padding: 0.35em 0.7em;
  border: 1px solid var(--sd-magenta);
  color: var(--sd-text);
  font-size: 0.72em;
  font-weight: 700;
  letter-spacing: 0.22em;
  box-shadow: 0 0 1.2em rgba(255, 43, 214, 0.55), inset 0 0 0.9em rgba(255, 43, 214, 0.3);
  animation: var(--sd-pop-in) 0.5s ease-out both;
}
.sd-delta.is-faster { color: var(--sd-cyan); }
.sd-delta.is-slower { color: var(--sd-amber); }
.sd-stats { display: grid; margin: 0; }
.sd-stat { display: flex; justify-content: space-between; align-items: baseline; gap: 1em; padding: 0.45em 0; border-bottom: 1px solid var(--sd-faint); }
.sd-stat dd { margin: 0; }

/* ---- Tuning panel ---- */
.sd-tune {
  position: absolute;
  top: max(0.7em, env(safe-area-inset-top));
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
.sd-calm .sd-ui { --sd-pop: sd-fade; --sd-flash: sd-fade; --sd-pop-in: sd-fade-in; }
.sd-calm .sd-hud-drift.is-live { box-shadow: 0 0 1.4em rgba(var(--sd-rgb), 0.16); }
@media (prefers-reduced-motion: reduce) {
  .sd-ui { --sd-pop: sd-fade; --sd-flash: sd-fade; --sd-pop-in: sd-fade-in; }
  .sd-ui, .sd-ui *, .sd-ui *::before, .sd-ui *::after { transition: none !important; }
}
@media (max-width: 760px) {
  .sd-title-grid { grid-template-columns: minmax(0, 1fr); }
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
