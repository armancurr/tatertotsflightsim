/**
 * Minimal WebAudio mock for node tests. It behaves like the browser where it matters for us:
 * AudioParam automation rejects non-finite values (the real API throws TypeError), exponential
 * ramps reject values <= 0, and PeriodicWave arrays must match in length. Instead of throwing we
 * record violations so tests can assert there were none (the synth also has a try/catch net).
 */
export const violations: string[] = [];

export class MockParam {
  private _value: number;
  directSets = 0;
  events: { type: string; value: number; time: number; tau?: number }[] = [];
  constructor(v = 0, readonly name = '') {
    this._value = v;
  }
  get value() {
    return this._value;
  }
  set value(v: number) {
    if (!Number.isFinite(v)) violations.push(`${this.name}.value = ${v}`);
    this.directSets++;
    this._value = v;
  }
  private check(kind: string, ...xs: number[]) {
    if (!xs.every(Number.isFinite)) violations.push(`${this.name}.${kind}(${xs.join(',')})`);
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    this.check('setTargetAtTime', v, t, tau);
    if (!(tau > 0)) violations.push(`${this.name}.setTargetAtTime tau=${tau}`);
    this.events.push({ type: 'target', value: v, time: t, tau });
    this._value = v;
    return this;
  }
  setValueAtTime(v: number, t: number) {
    this.check('setValueAtTime', v, t);
    this.events.push({ type: 'set', value: v, time: t });
    this._value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.check('linearRamp', v, t);
    this.events.push({ type: 'linear', value: v, time: t });
    this._value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.check('expRamp', v, t);
    if (!(v > 0)) violations.push(`${this.name}.exponentialRamp to ${v}`);
    this.events.push({ type: 'exp', value: v, time: t });
    this._value = v;
    return this;
  }
  cancelScheduledValues(t: number) {
    this.check('cancel', t);
    return this;
  }
  cancelAndHoldAtTime(t: number) {
    this.check('cancelAndHold', t);
    return this;
  }
}

export class MockNode {
  outputs: (MockNode | MockParam)[] = [];
  disconnected = false;
  constructor(readonly ctx: MockAudioContext, readonly kind: string) {
    ctx.nodes.push(this);
  }
  connect<T extends MockNode | MockParam>(dst: T): T {
    if (!dst) violations.push(`${this.kind}.connect(undefined)`);
    this.outputs.push(dst);
    return dst;
  }
  disconnect() {
    this.disconnected = true;
    this.outputs = [];
  }
}

export class MockScheduled extends MockNode {
  started: number | null = null;
  stopped: number | null = null;
  ended = false;
  onended: (() => void) | null = null;
  start(t = 0) {
    if (!Number.isFinite(t)) violations.push(`${this.kind}.start(${t})`);
    if (this.started !== null) violations.push(`${this.kind} started twice`);
    this.started = t;
  }
  stop(t = 0) {
    if (!Number.isFinite(t)) violations.push(`${this.kind}.stop(${t})`);
    this.stopped = t;
  }
}

export class MockOscillator extends MockScheduled {
  type = 'sine';
  frequency = new MockParam(440, 'osc.frequency');
  detune = new MockParam(0, 'osc.detune');
  wave: unknown = null;
  constructor(ctx: MockAudioContext) {
    super(ctx, 'oscillator');
  }
  setPeriodicWave(w: unknown) {
    this.wave = w;
    this.type = 'custom';
  }
}

export class MockBufferSource extends MockScheduled {
  buffer: MockBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new MockParam(1, 'src.playbackRate');
  detune = new MockParam(0, 'src.detune');
  constructor(ctx: MockAudioContext) {
    super(ctx, 'bufferSource');
  }
}

export class MockGain extends MockNode {
  gain = new MockParam(1, 'gain.gain');
  constructor(ctx: MockAudioContext) {
    super(ctx, 'gain');
  }
}

export class MockBiquad extends MockNode {
  type = 'lowpass';
  frequency = new MockParam(350, 'biquad.frequency');
  Q = new MockParam(1, 'biquad.Q');
  gain = new MockParam(0, 'biquad.gain');
  detune = new MockParam(0, 'biquad.detune');
  constructor(ctx: MockAudioContext) {
    super(ctx, 'biquad');
  }
}

export class MockCompressor extends MockNode {
  threshold = new MockParam(-24, 'comp.threshold');
  knee = new MockParam(30, 'comp.knee');
  ratio = new MockParam(12, 'comp.ratio');
  attack = new MockParam(0.003, 'comp.attack');
  release = new MockParam(0.25, 'comp.release');
  constructor(ctx: MockAudioContext) {
    super(ctx, 'compressor');
  }
}

export class MockWaveShaper extends MockNode {
  curve: Float32Array | null = null;
  oversample = 'none';
  constructor(ctx: MockAudioContext) {
    super(ctx, 'waveShaper');
  }
}

export class MockAnalyser extends MockNode {
  fftSize = 2048;
  constructor(ctx: MockAudioContext) {
    super(ctx, 'analyser');
  }
  getFloatTimeDomainData(a: Float32Array) {
    a.fill(0);
  }
}

export class MockBuffer {
  private data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(i: number) {
    return this.data[i];
  }
  copyToChannel(src: Float32Array, ch: number) {
    this.data[ch].set(src);
  }
}

export class MockAudioContext {
  static instances: MockAudioContext[] = [];
  nodes: MockNode[] = [];
  currentTime = 0;
  sampleRate = 44100;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination: MockNode;
  resumeCalls = 0;
  constructor() {
    this.destination = new MockNode(this, 'destination');
    MockAudioContext.instances.push(this);
  }
  async resume() {
    this.resumeCalls++;
    if (this.state !== 'closed') this.state = 'running';
  }
  async suspend(_t?: number) {
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
  createOscillator() {
    return new MockOscillator(this);
  }
  createGain() {
    return new MockGain(this);
  }
  createBiquadFilter() {
    return new MockBiquad(this);
  }
  createBufferSource() {
    return new MockBufferSource(this);
  }
  createDynamicsCompressor() {
    return new MockCompressor(this);
  }
  createWaveShaper() {
    return new MockWaveShaper(this);
  }
  createAnalyser() {
    return new MockAnalyser(this);
  }
  createBuffer(ch: number, len: number, sr: number) {
    if (!(len > 0) || !(sr > 0)) violations.push(`createBuffer(${ch},${len},${sr})`);
    return new MockBuffer(ch, len, sr);
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array) {
    if (real.length !== imag.length) violations.push('periodicWave length mismatch');
    if (![...real, ...imag].every(Number.isFinite)) violations.push('periodicWave non-finite');
    return { real, imag };
  }
  /** Test helper: advance the audio clock. */
  advance(dt: number) {
    this.currentTime += dt;
  }
  /** Test helper: fire `onended` of every source whose stop time has passed (like the browser does). */
  endFinished() {
    for (const n of this.nodes) {
      if (!(n instanceof MockScheduled) || n.ended || n.stopped === null || n.stopped > this.currentTime) continue;
      n.ended = true;
      n.onended?.();
    }
  }
  /** Nodes still connected into the graph (not disconnected), excluding the destination. */
  liveNodes() {
    return this.nodes.filter((n) => n !== this.destination && !n.disconnected).length;
  }
  count(kind: string) {
    return this.nodes.filter((n) => n.kind === kind).length;
  }
  started(kind: string) {
    return this.nodes.filter((n) => n.kind === kind && (n as MockScheduled).started !== null).length;
  }
}

/** Every AudioParam reachable from the nodes of `ctx`. */
export function allParams(ctx: MockAudioContext): MockParam[] {
  const out: MockParam[] = [];
  for (const n of ctx.nodes) for (const v of Object.values(n)) if (v instanceof MockParam) out.push(v);
  return out;
}

/**
 * OfflineAudioContext stand-in: records suspend points and, in startRendering(), walks the clock
 * through them (resolving each suspend and waiting for resume()), then returns a silent buffer.
 * Lets node tests check the self-test's timeline logic (not the audio itself).
 */
export class MockOfflineContext extends MockAudioContext {
  private points: { t: number; resolve: () => void }[] = [];
  private resumed: (() => void) | null = null;
  constructor(readonly numberOfChannels: number, readonly length: number, sampleRate: number) {
    super();
    this.sampleRate = sampleRate;
    this.state = 'running';
  }
  suspend(t: number): Promise<void> {
    if (this.points.some((p) => Math.abs(p.t - t) < 1e-9)) violations.push(`offline.suspend twice at ${t}`);
    return new Promise((resolve) => this.points.push({ t, resolve }));
  }
  resume(): Promise<void> {
    this.resumed?.();
    return Promise.resolve();
  }
  async startRendering(): Promise<MockBuffer> {
    this.points.sort((a, b) => a.t - b.t);
    for (const p of this.points) {
      this.currentTime = p.t;
      await new Promise<void>((r) => {
        this.resumed = r;
        p.resolve();
      });
    }
    this.currentTime = this.length / this.sampleRate;
    return new MockBuffer(this.numberOfChannels, this.length, this.sampleRate);
  }
}
