import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEffects, augmentAudio, seededRandom, snrDb } from '../src/audio/augment.js';
import { decodeWav, encodeWav } from '../src/audio/wav.js';
import { Engine } from '../src/engine.js';
import { getCheckType } from '../src/checks/index.js';
import { executeTarget } from '../src/targets/index.js';
import { TargetSpec } from '../src/specs.js';
import type { LlmClient } from '../src/providers/types.js';
import { mapSeq } from '../src/util.js';

const RATE = 16000;
const sine = (hz: number, seconds = 1, amp = 0.3) => Float32Array.from({ length: RATE * seconds }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('audio augmentation', () => {
  it('adds noise at the requested SNR (white and pink)', () => {
    const clean = sine(440);
    for (const color of ['white', 'pink'] as const) {
      for (const target of [0, 10, 20]) {
        const noisy = applyEffects(clean, RATE, [{ type: 'noise', snrDb: target, color }], seededRandom('x'));
        expect(Math.abs(snrDb(clean, noisy) - target)).toBeLessThan(1);
      }
    }
  });

  it('is reproducible from the seed', () => {
    const clean = sine(300);
    const a = applyEffects(clean, RATE, [{ type: 'noise', snrDb: 5 }, { type: 'dropouts', percent: 20 }], seededRandom('row1:cafe'));
    const b = applyEffects(clean, RATE, [{ type: 'noise', snrDb: 5 }, { type: 'dropouts', percent: 20 }], seededRandom('row1:cafe'));
    const c = applyEffects(clean, RATE, [{ type: 'noise', snrDb: 5 }, { type: 'dropouts', percent: 20 }], seededRandom('row2:cafe'));
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(Buffer.from(a.buffer).equals(Buffer.from(c.buffer))).toBe(false);
  });

  it('telephone keeps length and band-limits to ~300–3400 Hz', () => {
    const voiceBand = applyEffects(sine(1000), RATE, [{ type: 'telephone' }], seededRandom(1));
    const high = applyEffects(sine(6000), RATE, [{ type: 'telephone' }], seededRandom(1));
    expect(Math.abs(voiceBand.length - RATE)).toBeLessThanOrEqual(2);
    expect(rms(voiceBand)).toBeGreaterThan(0.15);
    expect(rms(high)).toBeLessThan(0.03);
  });

  it('gain, speed, lowpass, reverb and clip behave', () => {
    const x = sine(440);
    expect(rms(applyEffects(x, RATE, [{ type: 'gain', db: -12 }], seededRandom(1))) / rms(x)).toBeCloseTo(10 ** (-12 / 20), 2);
    expect(applyEffects(x, RATE, [{ type: 'speed', rate: 2 }], seededRandom(1)).length).toBeCloseTo(RATE / 2, -1);
    expect(rms(applyEffects(sine(5000), RATE, [{ type: 'lowpass', hz: 1000 }], seededRandom(1)))).toBeLessThan(0.03);
    expect(applyEffects(x, RATE, [{ type: 'reverb', amount: 0.8 }], seededRandom(1)).length).toBeGreaterThan(RATE);
    const clipped = applyEffects(x, RATE, [{ type: 'clip', level: 0.3 }], seededRandom(1));
    expect(Math.max(...clipped)).toBeLessThanOrEqual(0.3 + 1e-6);
  });

  it('augmentAudio returns a 16 kHz WAV', async () => {
    const wav = encodeWav([sine(440, 1)], 44100);
    const out = await augmentAudio(wav, 'audio/wav', [{ type: 'telephone' }], 's');
    const decoded = decodeWav(out.wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(out.durationMs).toBeGreaterThan(300);
  });
});

describe('jobs and media ops', () => {
  let engine: Engine;
  let dir: string;
  const calls: { kind: string; req: any }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-media-'));
    engine = await Engine.open({ dir });
    const stub: LlmClient = {
      text: async (req) => {
        calls.push({ kind: 'text', req });
        return { text: 'ok', latencyMs: 1, model: 'stub-text' };
      },
      json: async (req) => {
        calls.push({ kind: 'json', req });
        return { value: { reasoning: 'Looks right', verdict: 'pass' } as any, latencyMs: 1, model: 'stub-judge' };
      },
      image: async (req) => {
        calls.push({ kind: 'image', req });
        return { images: [{ data: PNG, mime: 'image/png' }], latencyMs: 1, model: 'stub-image' };
      },
      speech: async (req) => {
        calls.push({ kind: 'speech', req });
        return { audio: { data: encodeWav([sine(220, 0.5)], 24000), mime: 'audio/wav' }, latencyMs: 1, model: 'stub-tts' };
      },
      transcribe: async (req) => {
        calls.push({ kind: 'transcribe', req });
        return { text: ' hello world ', language: 'en', latencyMs: 1, model: 'stub-stt' };
      },
    };
    (engine as any).llm = stub;
  });

  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a job to completion and supports cancel', async () => {
    const j = engine.jobs.start('test', 'Counting', async (job) => {
      for (let i = 1; i <= 3; i++) job.progress(i, 3);
      return { n: 3 };
    });
    const done = await engine.jobs.wait(j.id);
    expect(done.status).toBe('completed');
    expect(done.result).toEqual({ n: 3 });
    expect(done.done).toBe(3);

    const slow = engine.jobs.start('test', 'Slow', async (job) => {
      await new Promise((r, reject) => {
        const t = setTimeout(r, 5000);
        job.signal.addEventListener('abort', () => (clearTimeout(t), reject(job.signal.reason)));
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.jobs.cancel(slow.id)).toBe(true);
    expect((await engine.jobs.wait(slow.id)).status).toBe('cancelled');
  });

  it('generates images for existing rows and as new rows', async () => {
    await engine.call('create_connection', { name: 'Stub', spec: { provider: 'openai', imageModel: 'gpt-image-2' } });
    await engine.call('create_dataset', { name: 'Photos', columns: [{ key: 'item', type: 'text' }, { key: 'image', type: 'image' }] });
    await engine.call('add_dataset_rows', { dataset: 'Photos', rows: [{ data: { item: 'red mug' } }, { data: { item: 'blue chair' } }] });

    const { jobId } = await engine.call('generate_images', { dataset: 'Photos', column: 'image', promptTemplate: 'A photo of {{item}}', connectionId: 'Stub', quality: 'medium' });
    const job = await engine.jobs.wait(jobId);
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ updated: 2, failed: 0 });
    expect(calls.filter((c) => c.kind === 'image').map((c) => c.req.prompt)).toEqual(expect.arrayContaining(['A photo of red mug', 'A photo of blue chair']));
    expect(calls.find((c) => c.kind === 'image')!.req.options).toEqual({ quality: 'medium' });
    const rows = (await engine.call('list_rows', { dataset: 'Photos' })).rows;
    expect((await mapSeq(rows, async (r: any) => !!r.data.image?.blob && (await engine.blobs.has(r.data.image.blob)))).every(Boolean)).toBe(true);
    expect(rows[0].provenance.media.image.kind).toBe('image');

    const again = await engine.jobs.wait((await engine.call('generate_images', { dataset: 'Photos', column: 'image', promptTemplate: 'A photo of {{item}}', connectionId: 'Stub' })).jobId);
    expect(again.result).toMatchObject({ total: 0 }); // fill_empty: nothing left to do

    const created = await engine.jobs.wait(
      (await engine.call('generate_images', { dataset: 'Photos', column: 'image', mode: 'new_rows', prompts: ['a green lamp', 'a yellow sofa'], promptColumn: 'item', connectionId: 'Stub' })).jobId,
    );
    expect(created.result).toMatchObject({ created: 2 });
    const review = (await engine.call('list_rows', { dataset: 'Photos', status: ['needs_review'] })).rows;
    expect(review.map((r: any) => r.data.item).sort()).toEqual(['a green lamp', 'a yellow sofa']);
  });

  it('generates speech with rotating voices, transcribes, and makes variants', async () => {
    await engine.call('create_dataset', { name: 'Voice', columns: [{ key: 'reference', type: 'text' }, { key: 'audio', type: 'audio' }, { key: 'heard', type: 'text' }] });
    await engine.call('add_dataset_rows', { dataset: 'Voice', rows: ['one two', 'three four', 'five six'].map((reference) => ({ data: { reference } })) });

    const sp = await engine.jobs.wait(
      (await engine.call('generate_speech', { dataset: 'Voice', column: 'audio', textTemplate: '{{reference}}', voices: ['alloy', 'coral'], instructionsTemplate: 'Calm voice', connectionId: 'Stub', model: 'gpt-4o-mini-tts' })).jobId,
    );
    expect(sp.result).toMatchObject({ updated: 3, failed: 0 });
    let rows = (await engine.call('list_rows', { dataset: 'Voice' })).rows;
    expect(rows.map((r: any) => r.tags.find((t: string) => t.startsWith('voice:')))).toEqual(['voice:alloy', 'voice:coral', 'voice:alloy']);
    expect(calls.filter((c) => c.kind === 'speech').every((c) => c.req.instructions === 'Calm voice')).toBe(true);

    const tr = await engine.jobs.wait((await engine.call('transcribe_rows', { dataset: 'Voice', audioColumn: 'audio', textColumn: 'heard', connectionId: 'Stub', model: 'gpt-4o-transcribe' })).jobId);
    expect(tr.result).toMatchObject({ updated: 3 });
    rows = (await engine.call('list_rows', { dataset: 'Voice' })).rows;
    expect(rows.every((r: any) => r.data.heard === 'hello world' && r.status === 'needs_review')).toBe(true);

    const recipes = [
      { name: 'Cafe 10 dB', effects: [{ type: 'noise', snrDb: 10, color: 'pink' }] },
      { name: 'Phone line', effects: [{ type: 'telephone' }] },
    ];
    const aug = await engine.jobs.wait((await engine.call('augment_audio', { dataset: 'Voice', sourceColumn: 'audio', recipes })).jobId);
    expect(aug.result).toMatchObject({ created: 6, failed: 0 });
    const variants = (await engine.call('list_rows', { dataset: 'Voice', tag: 'aug:cafe-10-db' })).rows;
    expect(variants).toHaveLength(3);
    expect(variants[0].provenance.source).toBe('augmented');

    // Deterministic: re-running the same recipes yields duplicates, which are skipped.
    const again = await engine.jobs.wait((await engine.call('augment_audio', { dataset: 'Voice', sourceColumn: 'audio', recipes })).jobId);
    expect(again.result).toMatchObject({ created: 0, skipped: 6 });
  });

  it('passes attachments to the LLM judge', async () => {
    const check = getCheckType('llm_judge')!;
    const info = await engine.blobs.put(PNG, { mime: 'image/png', name: 'out.png' });
    const file = { blob: info.hash, name: 'out.png', mime: 'image/png' };
    const before = calls.length;
    const res = await check.run(
      { connectionId: 'Stub', attachments: ['{{output}}', '{{missing}}'] },
      { scope: { output: file, outputs: { output: file }, row: {}, response: {}, metrics: {}, vars: {}, error: '' }, env: engine.templateEnv(), llm: engine.llm, log: () => {}, workspaceDir: dir, signal: new AbortController().signal },
    );
    expect(res.status).toBe('pass');
    const req = calls.slice(before).find((c) => c.kind === 'json')!.req;
    expect(req.files).toHaveLength(1);
    expect(req.files[0].mime).toBe('image/png');
  });

  it('runs model targets for image, speech and transcription tasks', async () => {
    const ctx = (row: Record<string, unknown>) => ({
      row,
      rowId: 'r1',
      vars: {},
      env: engine.templateEnv(),
      blobs: engine.blobs,
      llm: engine.llm,
      signal: new AbortController().signal,
      log: () => {},
      workspaceDir: dir,
    });
    const img = await executeTarget(TargetSpec.parse({ config: { kind: 'model', task: 'image', connectionId: 'Stub', prompt: 'A {{item}}' } }), ctx({ item: 'cat' }));
    expect(img.ok).toBe(true);
    expect((img.outputs.output as any).blob).toMatch(/^[a-f0-9]{64}$/);

    const tts = await executeTarget(TargetSpec.parse({ config: { kind: 'model', task: 'speech', connectionId: 'Stub', prompt: '{{reference}}', voice: 'alloy' } }), ctx({ reference: 'hi' }));
    expect((tts.outputs.output as any).mime).toBe('audio/wav');

    const info = await engine.blobs.put(encodeWav([sine(200, 0.3)], 16000), { mime: 'audio/wav' });
    const stt = await executeTarget(TargetSpec.parse({ config: { kind: 'model', task: 'transcription', connectionId: 'Stub' } }), ctx({ audio: { blob: info.hash, mime: 'audio/wav' } }));
    expect(stt.outputs.output).toBe(' hello world ');
    expect(stt.metrics.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('sends image columns used in a model target\'s prompt to the model (text and image tasks)', async () => {
    const ctx = (row: Record<string, unknown>) => ({
      row,
      rowId: 'r1',
      vars: {},
      env: engine.templateEnv(),
      blobs: engine.blobs,
      llm: engine.llm,
      signal: new AbortController().signal,
      log: () => {},
      workspaceDir: dir,
    });
    const info = await engine.blobs.put(PNG, { mime: 'image/png', name: 'cat.png' });
    const image = { blob: info.hash, name: 'cat.png', mime: 'image/png' };

    let before = calls.length;
    const text = await executeTarget(
      TargetSpec.parse({ config: { kind: 'model', connectionId: 'Stub', system: 'You label photos.', prompt: 'What is in this photo? {{image}} Answer in one word. Hint: {{hint}}' } }),
      ctx({ image, hint: 'pets' }),
    );
    expect(text.ok).toBe(true);
    let req = calls.slice(before).find((c) => c.kind === 'text')!.req;
    expect(req.files).toHaveLength(1);
    expect(req.files[0].mime).toBe('image/png');
    expect(Buffer.from(req.files[0].data).equals(Buffer.from(PNG))).toBe(true);
    expect(req.prompt).toBe('What is in this photo? [attached file: cat.png] Answer in one word. Hint: pets');
    expect((text.request as any).files).toEqual([{ name: 'cat.png', mime: 'image/png', size: PNG.byteLength }]);

    // A list of images, and an image referenced only by the system prompt (the same file is sent once).
    const other = async (n: number, name: string) => {
      const i = await engine.blobs.put(Buffer.concat([Buffer.from(PNG), Buffer.from([n])]), { mime: 'image/png', name });
      return { blob: i.hash, name, mime: 'image/png' };
    };
    const [dog, bird] = [await other(1, 'dog.png'), await other(2, 'bird.png')];
    before = calls.length;
    await executeTarget(TargetSpec.parse({ config: { kind: 'model', connectionId: 'Stub', system: 'Style guide: {{guide}}', prompt: 'Compare {{photos}}' } }), ctx({ guide: image, photos: [dog, bird, image] }));
    req = calls.slice(before).find((c) => c.kind === 'text')!.req;
    expect(req.files).toHaveLength(3);
    expect(req.prompt).toBe('Compare [attached file: dog.png] [attached file: bird.png] [attached file: cat.png]');

    // No file in the prompt: nothing attached.
    before = calls.length;
    await executeTarget(TargetSpec.parse({ config: { kind: 'model', connectionId: 'Stub', prompt: 'Hi {{hint}}' } }), ctx({ image, hint: 'there' }));
    expect(calls.slice(before).find((c) => c.kind === 'text')!.req.files).toBeUndefined();

    // Explicit attachments: sent without appearing in the text; no duplicates; empty rows send nothing.
    before = calls.length;
    await executeTarget(
      TargetSpec.parse({ config: { kind: 'model', connectionId: 'Stub', prompt: 'Describe the photo. {{image}}', attachments: ['{{image}}', '{{extra}}', '{{missing}}'] } }),
      ctx({ image, extra: [image] }),
    );
    req = calls.slice(before).find((c) => c.kind === 'text')!.req;
    expect(req.files).toHaveLength(1);
    before = calls.length;
    await executeTarget(TargetSpec.parse({ config: { kind: 'model', connectionId: 'Stub', prompt: 'Describe the photo.', attachments: ['{{image}}'] } }), ctx({ image }));
    req = calls.slice(before).find((c) => c.kind === 'text')!.req;
    expect(req.files).toHaveLength(1);
    expect(req.prompt).toBe('Describe the photo.');
    const bad = await executeTarget(TargetSpec.parse({ config: { kind: 'model', connectionId: 'Stub', prompt: 'x', attachments: ['{{hint}}'] } }), ctx({ hint: 'not a file' }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/did not resolve to a file/);

    // Image generation: image columns become reference images.
    before = calls.length;
    const edit = await executeTarget(TargetSpec.parse({ config: { kind: 'model', task: 'image', connectionId: 'Stub', prompt: 'Make {{image}} look like a watercolour' } }), ctx({ image }));
    expect(edit.ok).toBe(true);
    req = calls.slice(before).find((c) => c.kind === 'image')!.req;
    expect(req.images).toHaveLength(1);
    expect(req.prompt).toBe('Make [attached file: cat.png] look like a watercolour');
  });
});
