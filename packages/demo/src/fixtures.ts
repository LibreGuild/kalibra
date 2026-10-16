import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAny, encodePcm16, encodeWav, resample, toMono } from '../../core/src/audio/convert.js';

/*
 * Demo audio: short spoken commands generated with macOS `say` (several accents when the voices
 * are installed). Without `say`, simple tone clips are synthesized so the demo still runs, but the
 * mock STT server can then only "recognize" clips it generated itself.
 */

export interface Utterance {
  id: string;
  text: string;
  keywords: string[];
  locale: string;
}

export interface FixtureEntry extends Utterance {
  file: string;
  voice: string;
  durationMs: number;
  /** sha256 of the 16 kHz mono PCM16 samples with trailing silence removed. */
  pcmHash: string;
  synthetic: boolean;
}

export const UTTERANCES: Utterance[] = [
  { id: 'u01', text: 'transfer fifteen hundred rupees to Priya on Monday', keywords: ['fifteen hundred', 'Priya', 'Monday'], locale: 'en_IN' },
  { id: 'u02', text: 'what is the balance on my savings account', keywords: ['balance', 'savings'], locale: 'en_US' },
  { id: 'u03', text: 'block my credit card ending in four two seven one', keywords: ['block', 'four two seven one'], locale: 'en_GB' },
  { id: 'u04', text: 'schedule a call with Doctor Mehta at three thirty tomorrow', keywords: ['Mehta', 'three thirty', 'tomorrow'], locale: 'en_IN' },
  { id: 'u05', text: 'set a reminder to pay the electricity bill on the fifth', keywords: ['electricity', 'fifth'], locale: 'en_US' },
  { id: 'u06', text: 'how much did I spend on groceries last month', keywords: ['groceries', 'last month'], locale: 'en_AU' },
  { id: 'u07', text: 'send two hundred dollars to Carlos for the concert tickets', keywords: ['two hundred', 'Carlos'], locale: 'en_US' },
  { id: 'u08', text: 'cancel my subscription to the premium plan', keywords: ['cancel', 'premium'], locale: 'en_GB' },
  { id: 'u09', text: 'book a table for four at seven pm on Friday', keywords: ['four', 'seven pm', 'Friday'], locale: 'en_US' },
  { id: 'u10', text: 'do not share my phone number with anyone', keywords: ['do not', 'phone number'], locale: 'en_IE' },
  { id: 'u11', text: 'increase the daily transfer limit to fifty thousand', keywords: ['fifty thousand', 'limit'], locale: 'en_IN' },
  { id: 'u12', text: 'read me the last three transactions please', keywords: ['three transactions'], locale: 'en_ZA' },
];

const PREFERRED_VOICES: Record<string, string[]> = {
  en_US: ['Samantha', 'Alex', 'Fred', 'Albert'],
  en_GB: ['Daniel', 'Eddy (English (UK))', 'Flo (English (UK))'],
  en_IN: ['Rishi', 'Aman', 'Veena'],
  en_AU: ['Karen', 'Lee'],
  en_IE: ['Moira'],
  en_ZA: ['Tessa'],
};

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', 'fixtures', 'audio');
const MANIFEST = () => join(FIXTURES_DIR, 'manifest.json');

/** Hash of the PCM a client would stream at 16 kHz PCM16 (trailing zero samples removed). */
export function pcmHash(pcm: Buffer): string {
  return createHash('sha256').update(trimTrailingZeros(pcm)).digest('hex');
}

export function trimTrailingZeros(pcm: Buffer): Buffer {
  let end = pcm.byteLength;
  while (end >= 2 && pcm[end - 1] === 0 && pcm[end - 2] === 0) end -= 2;
  return pcm.subarray(0, end);
}

/** Decodes any audio and returns 16 kHz mono PCM16 bytes. */
export async function toPcm16k(bytes: Uint8Array, mime?: string): Promise<Buffer> {
  const decoded = await decodeAny(bytes, mime);
  return encodePcm16(resample(toMono(decoded), decoded.sampleRate, 16000));
}

function installedVoices(): Map<string, string> {
  const byName = new Map<string, string>();
  const out = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  if (out.status !== 0) return byName;
  for (const line of out.stdout.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/);
    if (m) byName.set(m[1].trim(), m[2]);
  }
  return byName;
}

function pickVoice(locale: string, voices: Map<string, string>): string | undefined {
  for (const name of PREFERRED_VOICES[locale] ?? []) if (voices.has(name)) return name;
  for (const [name, loc] of voices) if (loc === locale) return name;
  return undefined;
}

/** Deterministic tone clip used when `say` is unavailable (length depends on the text). */
function synthesizeTone(text: string): Buffer {
  const sampleRate = 16000;
  const seconds = Math.max(1, text.split(' ').length * 0.35);
  const n = Math.round(seconds * sampleRate);
  const samples = new Float32Array(n);
  let seed = [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const freq = 200 + (seed % 400);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    samples[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / sampleRate) + 0.02 * ((seed / 2 ** 32) * 2 - 1);
  }
  return encodeWav([samples], sampleRate);
}

/** Creates the fixture clips once and returns the manifest. Safe to call repeatedly. */
export async function ensureFixtures(): Promise<FixtureEntry[]> {
  if (existsSync(MANIFEST())) {
    // The manifest stores file names; paths are resolved here so the repo can move.
    const manifest = (JSON.parse(readFileSync(MANIFEST(), 'utf8')) as FixtureEntry[]).map((m) => ({ ...m, file: join(FIXTURES_DIR, basename(m.file)) }));
    if (manifest.length === UTTERANCES.length && manifest.every((m) => existsSync(m.file))) return manifest;
  }
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const hasSay = process.platform === 'darwin' && spawnSync('which', ['say']).status === 0;
  const voices = hasSay ? installedVoices() : new Map<string, string>();
  const manifest: FixtureEntry[] = [];
  for (const u of UTTERANCES) {
    const file = join(FIXTURES_DIR, `${u.id}.wav`);
    let voice = 'tone';
    let synthetic = true;
    if (hasSay) {
      const v = pickVoice(u.locale, voices);
      const args = ['-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', ...(v ? ['-v', v] : []), u.text];
      execFileSync('say', args);
      voice = v ?? 'default';
      synthetic = false;
    } else {
      writeFileSync(file, synthesizeTone(u.text));
    }
    const bytes = readFileSync(file);
    const pcm = await toPcm16k(bytes, 'audio/wav');
    manifest.push({ ...u, file, voice, durationMs: Math.round((pcm.byteLength / 2 / 16000) * 1000), pcmHash: pcmHash(pcm), synthetic });
  }
  writeFileSync(MANIFEST(), JSON.stringify(manifest.map((m) => ({ ...m, file: basename(m.file) })), null, 2));
  return manifest;
}
