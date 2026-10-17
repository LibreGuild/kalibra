import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFormat, fitImageToSize, imageDimensions, ImageSizeError, MIN_SIDE } from '../src/media/image-size.js';
import { Engine } from '../src/engine.js';

/** A PNG that compresses badly (gradient plus noise), like a detailed generated image. */
function noisyPng(width: number, height: number, alpha = 255) {
  const png = new PNG({ width, height });
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x / width) * 255;
      png.data[i + 1] = (y / height) * 255;
      png.data[i + 2] = rnd() * 255;
      png.data[i + 3] = alpha;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

describe('fitting images under a file-size limit', () => {
  const big = noisyPng(1024, 768); // ≈ 1–2 MB

  it('produces a large test image to start from', () => {
    expect(big.length).toBeGreaterThan(900_000);
    expect(imageDimensions(big)).toEqual({ width: 1024, height: 768 });
  });

  for (const kb of [100, 50]) {
    it(`fits under ${kb} KB as a JPEG with the same aspect ratio`, () => {
      const r = fitImageToSize(big, 'image/png', kb * 1000);
      expect(r.changed).toBe(true);
      expect(r.mime).toBe('image/jpeg');
      expect(detectFormat(r.data)).toBe('jpeg');
      expect(r.data.length).toBeLessThanOrEqual(kb * 1000);
      expect(r.originalBytes).toBe(big.length);
      expect(r.quality).toBeGreaterThanOrEqual(30);
      // The header of the result agrees with what is reported, and the shape is kept.
      expect(imageDimensions(r.data)).toEqual({ width: r.width, height: r.height });
      expect(Math.abs(r.width! / r.height! - 1024 / 768)).toBeLessThan(0.02);
      expect(r.width).toBeGreaterThanOrEqual(MIN_SIDE);
    });
  }

  it('keeps an image that already fits exactly as it is', () => {
    const small = noisyPng(40, 30);
    const r = fitImageToSize(small, 'image/png', 50_000);
    expect(r.changed).toBe(false);
    expect(r.mime).toBe('image/png');
    expect(r.data).toBe(small);
    expect(r.width).toBe(40);
  });

  it('shrinks a JPEG too, keeping its size when only quality needs to drop', () => {
    const rgba = PNG.sync.read(Buffer.from(noisyPng(300, 200))).data;
    const source = new Uint8Array(jpeg.encode({ data: rgba, width: 300, height: 200 }, 100).data);
    const limit = Math.floor(source.length * 0.6);
    const r = fitImageToSize(source, 'image/jpeg', limit);
    expect(r.data.length).toBeLessThanOrEqual(limit);
    expect(r.originalWidth).toBe(300);
    expect(r.width).toBe(300);
  });

  it('turns transparency white instead of black', () => {
    const r = fitImageToSize(noisyPng(400, 400, 0), 'image/png', 20_000);
    const px = jpeg.decode(r.data, { useTArray: true });
    expect(px.data[0]).toBeGreaterThan(240);
  });

  it('fails clearly when even the smallest version is too big', () => {
    expect(() => fitImageToSize(big, 'image/png', 200)).toThrow(ImageSizeError);
    expect(() => fitImageToSize(big, 'image/png', 200)).toThrow(/Could not get this image under 0\.2 KB.*Raise the limit/);
  });

  it('explains that WebP and unknown formats cannot be shrunk', () => {
    const webp = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 '), ...new Array(200_000).fill(1)]);
    expect(() => fitImageToSize(webp, 'image/webp', 1000)).toThrow(/Can't shrink WEBP images/);
  });
});

describe('generate_images with maxKb', () => {
  let engine: Engine;
  let dir: string;
  const big = noisyPng(800, 600);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-imgsize-'));
    engine = await Engine.open({ dir });
    await engine.call('create_connection', { name: 'Img', spec: { provider: 'openai', imageModel: 'gpt-image-2' } });
    await engine.call('create_dataset', { name: 'Pics', columns: [{ key: 'prompt' }, { key: 'image', type: 'image' }] });
  });
  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores images under the limit and records how they were changed', async () => {
    const seen: any[] = [];
    (engine as any).llm = { ...engine.llm, image: async (req: any) => (seen.push(req), { images: [{ data: big, mime: 'image/png' }], latencyMs: 1, model: 'gpt-image-2' }) };
    const { jobId } = await engine.call<any>('generate_images', { dataset: 'Pics', column: 'image', mode: 'new_rows', prompts: ['a cat', 'a dog'], promptColumn: 'prompt', connectionId: 'Img', maxKb: 50 });
    const job = await engine.jobs.wait(jobId);
    expect(job.status).toBe('completed');
    // GPT Image models are asked for PNG so the result can be re-encoded.
    expect(seen[0].options).toMatchObject({ output_format: 'png' });
    const { rows } = await engine.call<any>('list_rows', { dataset: 'Pics' });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.data.image.mime).toBe('image/jpeg');
      expect(row.data.image.size).toBeLessThanOrEqual(50_000);
      expect(row.data.image.name).toMatch(/\.jpg$/);
      expect(row.provenance.sizing).toMatchObject({ limitKb: 50, originalBytes: big.length, originalWidth: 800, originalHeight: 600, reencoded: true });
      expect(row.provenance.sizing.bytes).toBe(row.data.image.size);
    }
  });

  it('leaves images alone without a limit, and reports a per-row error when the limit cannot be met', async () => {
    (engine as any).llm = { ...engine.llm, image: async (req: any) => ({ images: [{ data: big, mime: 'image/png' }], latencyMs: 1, model: 'gpt-image-2', req }) };
    const plain = await engine.jobs.wait((await engine.call<any>('generate_images', { dataset: 'Pics', column: 'image', mode: 'new_rows', prompts: ['raw'], connectionId: 'Img' })).jobId);
    expect(plain.status).toBe('completed');
    const { rows } = await engine.call<any>('list_rows', { dataset: 'Pics' });
    const raw = rows.find((r: any) => r.data.image.size === big.length);
    expect(raw.data.image.mime).toBe('image/png');
    expect(raw.provenance.sizing).toBeUndefined();

    const tiny = await engine.jobs.wait((await engine.call<any>('generate_images', { dataset: 'Pics', column: 'image', mode: 'new_rows', prompts: ['too small'], connectionId: 'Img', maxKb: 0.1 })).jobId);
    expect(JSON.stringify(tiny)).toMatch(/Could not get this image under 0\.1 KB/);
  });
});
