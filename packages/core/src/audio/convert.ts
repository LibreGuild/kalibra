import { spawn } from 'node:child_process';
import { decodeWav, isWav, toMono, type DecodedAudio } from './wav.js';

/*
 * Audio preparation for streaming targets: decode any input, resample, then encode to the wire
 * format a service expects (PCM16, float32, G.711 μ-law/A-law).
 */

export type WireEncoding = 'pcm_s16le' | 'pcm_f32le' | 'mulaw' | 'alaw';

export function durationMs(audio: DecodedAudio): number {
  return ((audio.channels[0]?.length ?? 0) / audio.sampleRate) * 1000;
}

/** Linear-interpolation resampler. Good enough for test audio; not a mastering-grade filter. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[Math.min(i0, samples.length - 1)] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

export function encodePcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return buf;
}

export function encodeFloat32(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], i * 4);
  return buf;
}

/** G.711 μ-law (as used by telephony / Twilio media streams). */
export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let pcm = ((mantissa << 3) + 0x84) << exponent;
  pcm -= 0x84;
  return (sign ? -pcm : pcm) / 32768;
}

const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

/** G.711 A-law (follows the reference g711.c implementation). */
export function linearToAlaw(sample: number): number {
  let pcm = Math.round(Math.max(-1, Math.min(1, sample)) * 32767) >> 3;
  let mask: number;
  if (pcm >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  let seg = 0;
  while (seg < 8 && pcm > ALAW_SEG_END[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  const aval = (seg << 4) | ((seg < 2 ? pcm >> 1 : pcm >> seg) & 0x0f);
  return aval ^ mask;
}

export function alawToLinear(byte: number): number {
  const a = byte ^ 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  let pcm = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return (sign ? pcm : -pcm) / 32768;
}

export function encodeSamples(samples: Float32Array, encoding: WireEncoding): Buffer {
  switch (encoding) {
    case 'pcm_s16le':
      return encodePcm16(samples);
    case 'pcm_f32le':
      return encodeFloat32(samples);
    case 'mulaw': {
      const out = Buffer.alloc(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = linearToMulaw(samples[i]);
      return out;
    }
    case 'alaw': {
      const out = Buffer.alloc(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = linearToAlaw(samples[i]);
      return out;
    }
  }
}

export const bytesPerSample = (encoding: WireEncoding) => (encoding === 'pcm_s16le' ? 2 : encoding === 'pcm_f32le' ? 4 : 1);

/** Decodes WAV natively; anything else (mp3, ogg, flac, m4a, webm…) is converted with ffmpeg if installed. */
export async function decodeAny(bytes: Uint8Array, mime?: string): Promise<DecodedAudio> {
  if (isWav(bytes)) {
    try {
      return decodeWav(bytes);
    } catch (e) {
      // Fall through to ffmpeg for WAV variants we don't parse (ADPCM etc.).
      if (!(e instanceof Error) || !/Unsupported/.test(e.message)) throw e;
    }
  }
  const wav = await ffmpegToWav(bytes, mime);
  return decodeWav(wav);
}

export function ffmpegToWav(bytes: Uint8Array, mime?: string, sampleRate = 16000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(sampleRate), '-f', 'wav', 'pipe:1']);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`Cannot decode ${mime || 'this audio format'}: only WAV is built in. Install ffmpeg (e.g. "brew install ffmpeg") to use other formats.`));
      } else reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg failed to decode audio (exit ${code}): ${stderr.trim().slice(0, 300)}`));
    });
    proc.stdin.on('error', () => {
      /* ffmpeg may close stdin early on bad input; the close handler reports it */
    });
    proc.stdin.end(Buffer.from(bytes));
  });
}

/** Decode → mono (or keep channels) → resample → encode. Returns interleaved bytes for the wire. */
export async function prepareAudio(
  bytes: Uint8Array,
  opts: { mime?: string; sampleRate: number; channels: number; encoding: WireEncoding },
): Promise<{ data: Buffer; durationMs: number; bytesPerMs: number }> {
  const decoded = await decodeAny(bytes, opts.mime);
  const sourceChannels = opts.channels === 1 ? [toMono(decoded)] : decoded.channels.slice(0, opts.channels);
  while (sourceChannels.length < opts.channels) sourceChannels.push(sourceChannels[0]);
  const resampled = sourceChannels.map((ch) => resample(ch, decoded.sampleRate, opts.sampleRate));
  let interleaved: Float32Array;
  if (resampled.length === 1) interleaved = resampled[0];
  else {
    const n = resampled[0].length;
    interleaved = new Float32Array(n * resampled.length);
    for (let i = 0; i < n; i++) for (let c = 0; c < resampled.length; c++) interleaved[i * resampled.length + c] = resampled[c][i];
  }
  const data = encodeSamples(interleaved, opts.encoding);
  const ms = (resampled[0].length / opts.sampleRate) * 1000;
  return { data, durationMs: ms, bytesPerMs: (opts.sampleRate * opts.channels * bytesPerSample(opts.encoding)) / 1000 };
}

export { decodeWav, encodeWav, isWav, toMono } from './wav.js';
export type { DecodedAudio } from './wav.js';
