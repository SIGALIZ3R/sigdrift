/**
 * A stand-in for the WebAudio API that makes no sound but remembers everything: which nodes exist, how they are
 * connected, what was scheduled on every parameter. It also refuses the calls a real AudioContext refuses
 * (ramping exponentially to zero, starting a source twice, non-finite values), so wiring mistakes that would
 * throw or go silent in a browser fail the tests instead.
 */

export interface ParamEvent {
  kind: 'set' | 'linear' | 'exponential' | 'target' | 'cancel';
  value: number;
  time: number;
  timeConstant?: number;
}

function requireFinite(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${what} must be finite, got ${value}`);
}

export class FakeParam {
  readonly events: ParamEvent[] = [];
  /** Nodes connected to this parameter (modulators). */
  readonly inputs: FakeNode[] = [];
  private current: number;

  constructor(
    readonly owner: FakeNode,
    readonly name: string,
    initial: number,
  ) {
    this.current = initial;
  }

  get value(): number {
    return this.current;
  }

  set value(v: number) {
    requireFinite(v, `${this.name}.value`);
    this.current = v;
  }

  /** Where the parameter ends up once everything scheduled so far has played out. */
  get settled(): number {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].kind !== 'cancel') return this.events[i].value;
    return this.current;
  }

  private push(kind: ParamEvent['kind'], value: number, time: number, timeConstant?: number): this {
    requireFinite(value, `${this.name} value`);
    requireFinite(time, `${this.name} time`);
    if (time < 0) throw new RangeError(`${this.name}: negative time`);
    this.events.push({ kind, value, time, timeConstant });
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    return this.push('set', value, time);
  }

  linearRampToValueAtTime(value: number, time: number): this {
    return this.push('linear', value, time);
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    if (!(value !== 0)) throw new RangeError(`${this.name}: exponential ramp to zero`);
    const previous = this.settled;
    if (previous === 0 || previous < 0 !== value < 0) {
      throw new RangeError(`${this.name}: exponential ramp from ${previous} to ${value}`);
    }
    return this.push('exponential', value, time);
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    requireFinite(timeConstant, `${this.name} timeConstant`);
    if (timeConstant < 0) throw new RangeError(`${this.name}: negative timeConstant`);
    return this.push('target', value, time, timeConstant);
  }

  cancelScheduledValues(time: number): this {
    requireFinite(time, `${this.name} cancel time`);
    // As in the real API: everything scheduled at or after `time` goes.
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].kind !== 'cancel' && this.events[i].time >= time) this.events.splice(i, 1);
    }
    this.events.push({ kind: 'cancel', value: Number.NaN, time });
    return this;
  }
}

export type NodeKind =
  | 'destination'
  | 'gain'
  | 'oscillator'
  | 'biquad'
  | 'bufferSource'
  | 'waveShaper'
  | 'compressor';

export class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];
  readonly inputs: FakeNode[] = [];
  readonly params: Record<string, FakeParam> = {};

  // Sources
  started = false;
  startTime = Number.NaN;
  startOffset = 0;
  stopped = false;
  stopTime = Number.NaN;
  onended: (() => void) | null = null;

  // Per-kind properties, set by the code under test.
  type = '';
  loop = false;
  buffer: FakeBuffer | null = null;
  curve: Float32Array | null = null;
  oversample = 'none';
  wave: FakePeriodicWave | null = null;

  constructor(
    readonly context: FakeAudioContext,
    readonly kind: NodeKind,
  ) {}

  param(name: string, initial: number): FakeParam {
    const param = new FakeParam(this, name, initial);
    this.params[name] = param;
    Object.defineProperty(this, name, { value: param, enumerable: true });
    return param;
  }

  connect<T extends FakeNode | FakeParam>(target: T): T {
    if (target instanceof FakeNode) {
      if (target.context !== this.context) throw new Error('connect: different context');
      if (target.isSource) throw new Error(`connect: a ${target.kind} has no input`);
      if (!this.outputs.includes(target)) {
        this.outputs.push(target);
        target.inputs.push(this);
      }
    } else if (target instanceof FakeParam) {
      if (!this.outputs.includes(target)) {
        this.outputs.push(target);
        target.inputs.push(this);
      }
    } else {
      throw new TypeError('connect: not a node or a param');
    }
    return target;
  }

  disconnect(): void {
    for (const target of this.outputs) {
      const index = target.inputs.indexOf(this);
      if (index >= 0) target.inputs.splice(index, 1);
    }
    this.outputs.length = 0;
  }

  get isSource(): boolean {
    return this.kind === 'oscillator' || this.kind === 'bufferSource';
  }

  start(when = 0, offset = 0): void {
    if (!this.isSource) throw new TypeError('start: not a source');
    if (this.started) throw new Error('InvalidStateError: start called twice');
    if (this.kind === 'bufferSource' && !this.buffer) throw new Error('start: buffer source without a buffer');
    requireFinite(when, 'start time');
    requireFinite(offset, 'start offset');
    this.started = true;
    this.startTime = Math.max(when, this.context.currentTime);
    this.startOffset = offset;
  }

  stop(when = 0): void {
    if (!this.isSource) throw new TypeError('stop: not a source');
    if (!this.started) throw new Error('InvalidStateError: stop before start');
    requireFinite(when, 'stop time');
    this.stopped = true;
    this.stopTime = Math.max(when, this.context.currentTime);
  }

  setPeriodicWave(wave: FakePeriodicWave): void {
    if (this.kind !== 'oscillator') throw new TypeError('setPeriodicWave: not an oscillator');
    this.wave = wave;
    this.type = 'custom';
  }

  /** True when signal from this node can get to `target` (through nodes, or by modulating one of their params). */
  reaches(target: FakeNode, seen = new Set<FakeNode>()): boolean {
    if (this === target) return true;
    if (seen.has(this)) return false;
    seen.add(this);
    for (const output of this.outputs) {
      const node = output instanceof FakeParam ? output.owner : output;
      if (node.reaches(target, seen)) return true;
    }
    return false;
  }
}

export class FakeBuffer {
  private readonly data: Float32Array;

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    if (!(length > 0)) throw new RangeError('createBuffer: empty buffer');
    this.data = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    if (channel !== 0) throw new RangeError('getChannelData: mono only');
    return this.data;
  }
}

export class FakePeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
  ) {}
}

type Listener = () => void;

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly sampleRate = 48000;
  readonly destination: FakeNode;
  readonly nodes: FakeNode[] = [];
  readonly waves: FakePeriodicWave[] = [];
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'running';
  private readonly listeners = new Set<Listener>();

  constructor(readonly options?: unknown) {
    this.destination = new FakeNode(this, 'destination');
    FakeAudioContext.instances.push(this);
  }

  private node(kind: NodeKind): FakeNode {
    if (this.state === 'closed') throw new Error('InvalidStateError: context is closed');
    const node = new FakeNode(this, kind);
    this.nodes.push(node);
    return node;
  }

  createGain(): FakeNode {
    const node = this.node('gain');
    node.param('gain', 1);
    return node;
  }

  createOscillator(): FakeNode {
    const node = this.node('oscillator');
    node.type = 'sine';
    node.param('frequency', 440);
    node.param('detune', 0);
    return node;
  }

  createBiquadFilter(): FakeNode {
    const node = this.node('biquad');
    node.type = 'lowpass';
    node.param('frequency', 350);
    node.param('Q', 1);
    node.param('gain', 0);
    return node;
  }

  createBufferSource(): FakeNode {
    const node = this.node('bufferSource');
    node.param('playbackRate', 1);
    return node;
  }

  createWaveShaper(): FakeNode {
    return this.node('waveShaper');
  }

  createDynamicsCompressor(): FakeNode {
    const node = this.node('compressor');
    node.param('threshold', -24);
    node.param('knee', 30);
    node.param('ratio', 12);
    node.param('attack', 0.003);
    node.param('release', 0.25);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  createPeriodicWave(real: Float32Array, imag: Float32Array): FakePeriodicWave {
    if (real.length !== imag.length || real.length < 2) throw new Error('createPeriodicWave: bad tables');
    const wave = new FakePeriodicWave(real, imag);
    this.waves.push(wave);
    return wave;
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Test control: change state the way the browser would, notifying listeners. */
  setState(state: 'suspended' | 'running' | 'closed'): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  resume(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('closed'));
    this.setState('running');
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('closed'));
    this.setState('suspended');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.setState('closed');
    return Promise.resolve();
  }

  // ---- inspection helpers ------------------------------------------------------------------------------------

  ofKind(kind: NodeKind): FakeNode[] {
    return this.nodes.filter((node) => node.kind === kind);
  }

  /** Sources that have been started and not told to stop. */
  get running(): FakeNode[] {
    return this.nodes.filter((node) => node.isSource && node.started && !node.stopped);
  }

  /** Let scheduled stops up to the current time take effect, firing `onended`. */
  finishEnded(): void {
    for (const node of this.nodes) {
      if (node.isSource && node.stopped && node.stopTime <= this.currentTime && node.onended) {
        const handler = node.onended;
        node.onended = null;
        handler();
      }
    }
  }
}
