import { describe, expect, it } from 'vitest';
import { GROUPS, SDK_BRIEF, SECTIONS } from '../src/sdk-docs/content';
import { LANGS, type Block, type Text } from '../src/sdk-docs/types';

/** Every block, including the ones inside language-only blocks. */
const allBlocks = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.type === 'only' ? [b, ...allBlocks(b.blocks)] : [b]));
const texts = (t: Text) => (typeof t === 'string' ? [t] : [t.js, t.python]);

describe('SDK docs content', () => {
  it('has a unique id for every section, in a known group', () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SECTIONS) {
      expect(s.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(GROUPS).toContain(s.group);
    }
  });

  it('gives every code sample both languages', () => {
    for (const s of SECTIONS) {
      for (const b of allBlocks(s.blocks)) {
        if (b.type !== 'code') continue;
        for (const lang of LANGS) expect(b.code[lang]?.trim(), `${s.id}: ${lang} code`).toBeTruthy();
      }
    }
  });

  it('links only to sections that exist', () => {
    const ids = new Set(SECTIONS.map((s) => s.id));
    const all: string[] = [];
    for (const s of SECTIONS) {
      all.push(...texts(s.title), ...texts(s.when));
      for (const b of allBlocks(s.blocks)) {
        if (b.type === 'text') all.push(...texts(b.text));
        if (b.type === 'callout') all.push(...texts(b.text));
        if (b.type === 'list' || b.type === 'steps') all.push(...b.items.flatMap(texts));
        if (b.type === 'table') all.push(...b.rows.flatMap((r) => (Array.isArray(r) ? r : r.cells)).flatMap(texts));
        if (b.type === 'qa') all.push(...b.items.flatMap((i) => [...texts(i.q), ...texts(i.a)]));
        if (b.type === 'cards') all.push(...b.items.flatMap((i) => [...texts(i.title), ...texts(i.text)]));
      }
    }
    const anchors = all.flatMap((t) => [...t.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(ids.has(a), `#${a}`).toBe(true);
  });

  it('describes both SDKs for the picker', () => {
    for (const lang of LANGS) expect(SDK_BRIEF[lang].text.length).toBeGreaterThan(20);
  });
});
