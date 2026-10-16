import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, toMono } from '../src/audio/wav.js';
import {
  alawToLinear,
  decodeAny,
  encodeSamples,
  linearToAlaw,
  linearToMulaw,
  mulawToLinear,
  prepareAudio,
  resample,
} from '../src/audio/convert.js';

const sine = (n: number, freq = 440, rate = 16000) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate));

describe('wav', () => {
  it('round-trips 16-bit PCM', () => {
    const samples = sine(1600);
    const decoded = decodeWav(encodeWav([samples], 16000));
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toHaveLength(1);
    expect(decoded.channels[0].length).toBe(1600);
    for (let i = 0; i < samples.length; i += 97) expect(decoded.channels[0][i]).toBeCloseTo(samples[i], 3);
  });

  it('decodes stereo and mixes to mono', () => {
    const left = new Float32Array(100).fill(0.5);
    const right = new Float32Array(100).fill(-0.5);
    const decoded = decodeWav(encodeWav([left, right], 8000));
    expect(decoded.channels).toHaveLength(2);
    expect(toMono(decoded)[10]).toBeCloseTo(0, 3);
  });

  it('skips unknown chunks before data (e.g. FLLR from macOS say)', () => {
    const base = encodeWav([sine(320)], 16000);
    const junk = Buffer.alloc(8 + 12);
    junk.write('FLLR', 0, 'latin1');
    junk.writeUInt32LE(12, 4);
    const wav = Buffer.concat([base.subarray(0, 36), junk, base.subarray(36)]);
    wav.writeUInt32LE(wav.byteLength - 8, 4);
    expect(decodeWav(wav).channels[0].length).toBe(320);
  });

  it('decodes 32-bit float WAV', () => {
    const n = 64;
    const buf = Buffer.alloc(44 + n * 4);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(36 + n * 4, 4);
    buf.write('WAVEfmt ', 8, 'latin1');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(3, 20); // float
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(8000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(32, 34);
    buf.write('data', 36, 'latin1');
    buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) buf.writeFloatLE(0.25, 44 + i * 4);
    const decoded = decodeWav(buf);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels[0][5]).toBeCloseTo(0.25, 5);
  });

  it('rejects non-WAV input with a clear message', () => {
    expect(() => decodeWav(Buffer.from('hello world, not audio'))).toThrow(/Not a WAV/);
  });
});

describe('codecs and resampling', () => {
  it('μ-law round trip stays close and silence encodes to 0xFF', () => {
    expect(linearToMulaw(0)).toBe(0xff);
    for (const v of [-0.9, -0.3, -0.01, 0.01, 0.3, 0.9]) expect(mulawToLinear(linearToMulaw(v))).toBeCloseTo(v, 1);
  });

  it('A-law round trip stays close and silence encodes to 0xD5', () => {
    expect(linearToAlaw(0)).toBe(0xd5);
    for (const v of [-0.9, -0.3, -0.01, 0.01, 0.3, 0.9]) expect(alawToLinear(linearToAlaw(v))).toBeCloseTo(v, 1);
  });

  it('encodes sample sizes per encoding', () => {
    const s = sine(10);
    expect(encodeSamples(s, 'pcm_s16le').byteLength).toBe(20);
    expect(encodeSamples(s, 'pcm_f32le').byteLength).toBe(40);
    expect(encodeSamples(s, 'mulaw').byteLength).toBe(10);
    expect(encodeSamples(s, 'alaw').byteLength).toBe(10);
  });

  it('resamples to the expected length', () => {
    expect(resample(sine(48000, 440, 48000), 48000, 16000).length).toBe(16000);
    expect(resample(sine(8000, 440, 8000), 8000, 16000).length).toBe(16000);
  });

  it('prepares wire audio with duration and byte rate', async () => {
    const wav = encodeWav([sine(44100, 440, 44100)], 44100);
    const out = await prepareAudio(wav, { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' });
    expect(out.durationMs).toBeCloseTo(1000, 0);
    expect(out.data.byteLength).toBe(32000);
    expect(out.bytesPerMs).toBe(32);
  });

  it('decodeAny explains how to handle formats without ffmpeg or decodes them with it', async () => {
    const notWav = Buffer.from('ID3\u0003junk-mp3-bytes');
    await expect(decodeAny(notWav, 'audio/mpeg')).rejects.toThrow(/ffmpeg/i);
  });
});
