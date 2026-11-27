import type { CarParams, CarState } from '../types';
import { el, injectStyles } from './styles';

export interface TuningOptions {
  /** The live parameter object. Asked for on every write, so it may change between levels. */
  getParams(): CarParams;
  defaults: CarParams;
  /** Called after the panel has written one or more values. */
  onChange?(): void;
}

export interface TuningPanel {
  toggle(): void;
  readonly visible: boolean;
  /** Live telemetry. Safe to call every frame: it refreshes at about 10 Hz and only while visible. */
  update(car: CarState): void;
  dispose(): void;
}

/** Numeric fields are found at run time (see paramKeys), so a key is just a name here. */
type ParamKey = string;
type ParamValues = Record<ParamKey, number>;

interface ParamRange {
  group: string;
  min: number;
  max: number;
  step: number;
}

interface ParamRow {
  key: ParamKey;
  slider: HTMLInputElement;
  readout: HTMLElement;
  digits: number;
}

interface TelemetryField {
  label: string;
  read(car: CarState): string;
}

const TELEMETRY_INTERVAL_MS = 100;
const COPY_FEEDBACK_MS = 1200;
const COPY_LABEL = 'Copy JSON';
const RAD_TO_DEG = 180 / Math.PI;
const MS_TO_KMH = 3.6;

function range(group: string, min: number, max: number, step: number): ParamRange {
  return { group, min, max, step };
}

const OTHER_GROUP = 'Other';

/**
 * Hand-picked slider travel for the fields we know, in display order. A numeric field that is not listed here
 * (one added to CarParams later) still gets a slider: see autoRange.
 */
const RANGES: Readonly<Record<ParamKey, ParamRange | undefined>> = {
  mass: range('Chassis', 400, 2500, 10),
  inertia: range('Chassis', 300, 4000, 10),
  cgToFront: range('Chassis', 0.5, 2.5, 0.01),
  cgToRear: range('Chassis', 0.5, 2.5, 0.01),
  cgHeight: range('Chassis', 0, 1.2, 0.01),
  weightTransfer: range('Chassis', 0, 1, 0.01),
  cornerStiffFront: range('Tyres', 1, 20, 0.1),
  cornerStiffRear: range('Tyres', 1, 20, 0.1),
  gripFront: range('Tyres', 0.3, 4, 0.01),
  gripRear: range('Tyres', 0.3, 4, 0.01),
  handbrakeGrip: range('Tyres', 0, 1, 0.01),
  powerSlip: range('Tyres', 0, 1, 0.01),
  slideGrip: range('Tyres', 0, 1, 0.01),
  engineForce: range('Power and brakes', 0, 25000, 100),
  reverseForce: range('Power and brakes', 0, 15000, 100),
  brakeForce: range('Power and brakes', 0, 30000, 100),
  handbrakeForce: range('Power and brakes', 0, 15000, 100),
  drag: range('Power and brakes', 0, 5, 0.01),
  rollingResistance: range('Power and brakes', 0, 100, 0.5),
  maxSteer: range('Steering', 0.1, 1.2, 0.01),
  maxSteerAtSpeed: range('Steering', 0.02, 1, 0.01),
  steerSpeedRef: range('Steering', 5, 80, 0.5),
  steerRate: range('Steering', 0.5, 20, 0.1),
  steerReturnRate: range('Steering', 0.5, 20, 0.1),
  yawDamping: range('Steering', 0, 10, 0.05),
  steerAssist: range('Steering', 0, 1, 0.01),
  collisionRadius: range('Body and walls', 0.3, 2, 0.01),
  halfLength: range('Body and walls', 1, 3.5, 0.01),
  halfWidth: range('Body and walls', 0.5, 1.5, 0.01),
  restitution: range('Body and walls', 0, 1, 0.01),
  wallFriction: range('Body and walls', 0, 1, 0.01),
};

const TELEMETRY: readonly TelemetryField[] = [
  { label: 'Speed', read: (car) => `${(car.speed * MS_TO_KMH).toFixed(0)} km/h` },
  { label: 'Drift', read: (car) => `${(car.driftAngle * RAD_TO_DEG).toFixed(1)}°` },
  { label: 'Slip F', read: (car) => `${(car.slipFront * RAD_TO_DEG).toFixed(1)}°` },
  { label: 'Slip R', read: (car) => `${(car.slipRear * RAD_TO_DEG).toFixed(1)}°` },
  { label: 'Yaw rate', read: (car) => `${(car.yawRate * RAD_TO_DEG).toFixed(0)}°/s` },
  { label: 'Rear slide', read: (car) => car.rearSlide.toFixed(2) },
];

/** CarParams is all numbers today; this view lets the panel treat whatever numeric fields it finds alike. */
function values(params: CarParams): ParamValues {
  return params as unknown as ParamValues;
}

/** A workable slider for a field nobody has tuned a range for: zero to three times the shipped value. */
function autoRange(value: number): ParamRange {
  const size = Math.max(Math.abs(value), 0.5);
  let step = 0.01;
  if (size >= 300) step = 10;
  else if (size >= 30) step = 1;
  else if (size >= 3) step = 0.1;
  const max = Math.ceil((size * 3) / step) * step;
  return range(OTHER_GROUP, value < 0 ? -max : 0, max, step);
}

function rangeFor(key: ParamKey, defaults: ParamValues): ParamRange {
  return RANGES[key] ?? autoRange(defaults[key]);
}

/** Every numeric field of the shipped car: the known ones in table order, then any newcomers. */
function paramKeys(defaults: ParamValues): ParamKey[] {
  const isNumeric = (key: ParamKey): boolean => typeof defaults[key] === 'number' && Number.isFinite(defaults[key]);
  const known = Object.keys(RANGES).filter(isNumeric);
  const extra = Object.keys(defaults).filter((key) => RANGES[key] === undefined && isNumeric(key));
  return known.concat(extra);
}

function digitsFor(step: number): number {
  if (step >= 1) return 0;
  return step >= 0.1 ? 1 : 2;
}

function showValue(row: ParamRow, value: number): void {
  row.slider.value = String(value);
  row.readout.textContent = value.toFixed(row.digits);
}

function buildRow(key: ParamKey, travel: ParamRange, defaults: ParamValues): { node: HTMLElement; row: ParamRow } {
  const { min, max, step } = travel;
  const slider = el('input', 'sd-range');
  slider.type = 'range';
  // The table is a guess at useful travel: never let it exclude the value the car actually ships with.
  slider.min = String(Math.min(min, defaults[key]));
  slider.max = String(Math.max(max, defaults[key]));
  slider.step = String(step);
  const readout = el('span', 'sd-num');
  const node = el('label', 'sd-tune-row');
  node.append(el('span', '', key), slider, readout);
  return { node, row: { key, slider, readout, digits: digitsFor(step) } };
}

function buildTelemetry(): { node: HTMLElement; cells: HTMLElement[] } {
  const node = el('dl', 'sd-tune-telemetry');
  const cells = TELEMETRY.map((field) => {
    const cell = el('dd', 'sd-num', '--');
    const pair = el('div');
    pair.append(el('dt', '', field.label), cell);
    node.appendChild(pair);
    return cell;
  });
  return { node, cells };
}

function buildRows(defaults: ParamValues): { node: HTMLElement; rows: ParamRow[] } {
  const node = el('div', 'sd-tune-body');
  const rows: ParamRow[] = [];
  let group = '';
  for (const key of paramKeys(defaults)) {
    const travel = rangeFor(key, defaults);
    if (travel.group !== group) {
      group = travel.group;
      node.appendChild(el('h3', 'sd-label sd-tune-group', group));
    }
    const built = buildRow(key, travel, defaults);
    node.appendChild(built.node);
    rows.push(built.row);
  }
  return { node, rows };
}

function smallButton(label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'sd-btn sd-btn-small', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function createTuningPanel(root: HTMLElement, opts: TuningOptions): TuningPanel {
  injectStyles();
  let visible = false;
  let lastTelemetryMs = -Infinity;
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const panel = el('div', 'sd-ui sd-panel sd-tune sd-hidden');
  const telemetry = buildTelemetry();
  const { node: body, rows } = buildRows(values(opts.defaults));
  const copyButton = smallButton(COPY_LABEL, copyJson);
  const actions = el('div', 'sd-tune-actions');
  actions.append(smallButton('Reset to defaults', resetToDefaults), copyButton);
  const head = el('div', 'sd-tune-head');
  head.append(el('div', 'sd-label', 'Car tuning'), telemetry.node, actions);
  panel.append(head, body);
  root.appendChild(panel);

  function syncFromParams(): void {
    const params = values(opts.getParams());
    for (const row of rows) showValue(row, params[row.key]);
  }

  function resetToDefaults(): void {
    const params = values(opts.getParams());
    const defaults = values(opts.defaults);
    for (const row of rows) params[row.key] = defaults[row.key];
    syncFromParams();
    opts.onChange?.();
  }

  function showCopyResult(label: string): void {
    copyButton.textContent = label;
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      copyButton.textContent = COPY_LABEL;
    }, COPY_FEEDBACK_MS);
  }

  function copyJson(): void {
    const json = JSON.stringify(opts.getParams(), null, 2);
    try {
      navigator.clipboard.writeText(json).then(
        () => showCopyResult('Copied'),
        () => showCopyResult('Copy failed'),
      );
    } catch {
      // No clipboard API at all (insecure context or an old browser).
      showCopyResult('Copy failed');
    }
  }

  // A focused slider or button would swallow the driving keys, so nothing in the panel keeps focus.
  function releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && panel.contains(focused)) focused.blur();
  }

  for (const row of rows) {
    row.slider.addEventListener('input', () => {
      const value = row.slider.valueAsNumber;
      values(opts.getParams())[row.key] = value;
      row.readout.textContent = value.toFixed(row.digits);
      opts.onChange?.();
    });
  }
  panel.addEventListener('change', releaseFocus);
  panel.addEventListener('pointerup', releaseFocus);
  panel.addEventListener('click', releaseFocus);

  return {
    toggle() {
      visible = !visible;
      panel.classList.toggle('sd-hidden', !visible);
      if (!visible) return;
      syncFromParams();
      lastTelemetryMs = -Infinity;
    },
    get visible() {
      return visible;
    },
    update(car) {
      if (!visible) return;
      const now = performance.now();
      if (now - lastTelemetryMs < TELEMETRY_INTERVAL_MS) return;
      lastTelemetryMs = now;
      for (let i = 0; i < TELEMETRY.length; i++) telemetry.cells[i].textContent = TELEMETRY[i].read(car);
    },
    dispose() {
      clearTimeout(copyFeedbackTimer);
      panel.remove();
    },
  };
}
