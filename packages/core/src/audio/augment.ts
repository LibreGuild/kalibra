import { decodeAny, encodeWav, linearToMulaw, mulawToLinear, resample, toMono } from './convert.js';

/*
 * Audio augmentation for speech-to-text test sets: turn clean clips into realistic ones
 * (background noise, phone lines, echoey rooms, quiet or fast speakers, dropouts).
 * Everything runs on 16 kHz mono float samples and is reproducible from a seed.
 */

export type AudioEffect =
  | { type: 'noise'; snrDb: number; color?: 'white' | 'pink' }
  | { type: 'telephone' }
  | { type: 'reverb'; amount: number }
  | { type: 'gain'; db: number }
  | { type: 'clip'; level: number }
  | { type: 'speed'; rate: number }
  | { type: 'lowpass'; hz: number }
  | { type: 'dropouts'; percent: number };

export const AUGMENT_RATE = 16000;

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: string | number): () => number {
  let h = typeof seed === 'number' ? seed >>> 0 : 2166136261;
  if (typeof seed === 'string') for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rms = (x: Float32Array) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
};

/** Signal-to-noise ratio in dB between a clean signal and its noisy version (same length). */
export function snrDb(clean: Float32Array, noisy: Float32Array): number {
  let sig = 0;
  let noise = 0;
  for (let i = 0; i < clean.length; i++) {
    sig += clean[i] * clean[i];
    const d = noisy[i] - clean[i];
    noise += d * d;
  }
  return 10 * Math.log10(sig / Math.max(noise, 1e-20));
}

function gaussian(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function makeNoise(n: number, color: 'white' | 'pink', rand: () => number): Float32Array {
  const out = new Float32Array(n);
  if (color === 'white') {
    for (let i = 0; i < n; i++) out[i] = gaussian(rand);
    return out;
  }
  // Paul Kellet's economy pink-noise filter.
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = gaussian(rand);
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  return out;
}

/** RBJ biquad filter (in place). */
function biquad(x: Float32Array, kind: 'lowpass' | 'highpass', freq: number, rate: number, q = Math.SQRT1_2): Float32Array {
  const w0 = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const [b0, b1, b2] = kind === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Schroeder/Freeverb-style room: parallel damped combs into series all-passes. O(n). */
function reverb(x: Float32Array, rate: number, amount: number): Float32Array {
  const a = Math.max(0, Math.min(1, amount));
  const scale = rate / 44100;
  const tail = Math.round(rate * (0.3 + a * 1.2));
  const input = new Float32Array(x.length + tail);
  input.set(x);
  const wet = new Float32Array(input.length);
  const feedback = 0.7 + a * 0.26;
  const damp = 0.3;
  for (const d of [1116, 1188, 1277, 1356, 1422, 1491]) {
    const len = Math.max(1, Math.round(d * scale));
    const buf = new Float32Array(len);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < input.length; i++) {
      const out = buf[idx];
      store = out * (1 - damp) + store * damp;
      buf[idx] = input[i] + store * feedback;
      wet[i] += out;
      idx = (idx + 1) % len;
    }
  }
  for (const d of [556, 441]) {
    const len = Math.max(1, Math.round(d * scale));
    const buf = new Float32Array(len);
    let idx = 0;
    for (let i = 0; i < wet.length; i++) {
      const bufOut = buf[idx];
      const out = -wet[i] + bufOut;
      buf[idx] = wet[i] + bufOut * 0.5;
      wet[i] = out;
      idx = (idx + 1) % len;
    }
  }
  const wetGain = (rms(x) / Math.max(rms(wet), 1e-9)) * (0.25 + a * 0.6);
  const out = new Float32Array(input.length);
  for (let i = 0; i < out.length; i++) out[i] = input[i] * (1 - a * 0.35) + wet[i] * wetGain;
  // Trim the silent part of the tail.
  let end = out.length;
  while (end > x.length && Math.abs(out[end - 1]) < 1e-4) end--;
  return out.slice(0, end);
}

/** Applies effects in order to mono samples at `rate` Hz. Returns new samples at `rate`. */
export function applyEffects(input: Float32Array, rate: number, effects: AudioEffect[], rand: () => number): Float32Array {
  let x: Float32Array = Float32Array.from(input);
  let clipped = false;
  for (const fx of effects) {
    switch (fx.type) {
      case 'noise': {
        const noise = makeNoise(x.length, fx.color ?? 'white', rand);
        const target = rms(x) / 10 ** (fx.snrDb / 20);
        const k = target / Math.max(rms(noise), 1e-12);
        for (let i = 0; i < x.length; i++) x[i] += noise[i] * k;
        break;
      }
      case 'telephone': {
        // Anti-alias before dropping to 8 kHz, band-limit to the 300–3400 Hz voice band, G.711 μ-law, back up.
        let y = biquad(biquad(x, 'lowpass', 3400, rate), 'lowpass', 3400, rate);
        y = resample(y, rate, 8000);
        y = biquad(y, 'highpass', 300, 8000);
        for (let i = 0; i < y.length; i++) y[i] = mulawToLinear(linearToMulaw(y[i]));
        x = biquad(resample(y, 8000, rate), 'lowpass', 3400, rate);
        break;
      }
      case 'reverb':
        x = reverb(x, rate, fx.amount);
        break;
      case 'gain': {
        const g = 10 ** (fx.db / 20);
        for (let i = 0; i < x.length; i++) x[i] *= g;
        break;
      }
      case 'clip': {
        const level = Math.max(0.01, Math.min(1, fx.level));
        let peak = 0;
        for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
        const t = peak * level;
        for (let i = 0; i < x.length; i++) x[i] = Math.max(-t, Math.min(t, x[i])) / Math.max(t, 1e-9) * Math.min(peak, 1);
        clipped = true;
        break;
      }
      case 'speed': {
        const r = Math.max(0.25, Math.min(4, fx.rate));
        x = resample(x, rate * r, rate);
        break;
      }
      case 'lowpass':
        x = biquad(x, 'lowpass', fx.hz, rate);
        break;
      case 'dropouts': {
        const frame = Math.round(rate * 0.02);
        const p = Math.max(0, Math.min(100, fx.percent)) / 100;
        for (let start = 0; start < x.length; start += frame) {
          if (rand() < p) x.fill(0, start, Math.min(x.length, start + frame));
        }
        break;
      }
    }
  }
  // Keep within [-1, 1] without changing loudness unless it would clip (intentional clipping already is).
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (!clipped && peak > 0.999) {
    const k = 0.999 / peak;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  return x;
}

/** Decode any audio → 16 kHz mono → effects → 16-bit WAV. */
export async function augmentAudio(bytes: Uint8Array, mime: string | undefined, effects: AudioEffect[], seed: string | number) {
  const decoded = await decodeAny(bytes, mime);
  const mono = resample(toMono(decoded), decoded.sampleRate, AUGMENT_RATE);
  const out = applyEffects(mono, AUGMENT_RATE, effects, seededRandom(seed));
  return { wav: encodeWav([out], AUGMENT_RATE), durationMs: (out.length / AUGMENT_RATE) * 1000 };
}

/** Short human label for an effect list, used in tags and summaries. */
export function describeEffects(effects: AudioEffect[]): string {
  return effects
    .map((e) => {
      switch (e.type) {
        case 'noise':
          return `${e.color ?? 'white'} noise ${e.snrDb} dB SNR`;
        case 'telephone':
          return 'phone line';
        case 'reverb':
          return `reverb ${e.amount}`;
        case 'gain':
          return `gain ${e.db} dB`;
        case 'clip':
          return `clipping ${e.level}`;
        case 'speed':
          return `speed ${e.rate}×`;
        case 'lowpass':
          return `low-pass ${e.hz} Hz`;
        case 'dropouts':
          return `${e.percent}% dropouts`;
      }
    })
    .join(', ');
}
