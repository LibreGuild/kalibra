import { describe, expect, it } from 'vitest';
import { align } from '../src/metrics/align.js';
import { normalizeText } from '../src/metrics/normalize.js';
import { charErrors, topConfusions, wordErrors } from '../src/metrics/wer.js';
import { chrF, exactMatch, levenshteinSimilarity, rougeL, sentenceBleu, tokenF1 } from '../src/metrics/text.js';

describe('align', () => {
  it('counts substitutions, deletions and insertions', () => {
    const a = align(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect([a.hits, a.subs, a.dels, a.ins]).toEqual([2, 1, 0, 1]);
    expect(a.ops.map((o) => o.op)).toEqual(['equal', 'sub', 'equal', 'ins']);
  });
  it('handles empty sides', () => {
    expect(align([], ['a']).ins).toBe(1);
    expect(align(['a', 'b'], []).dels).toBe(2);
    expect(align([], []).ops).toEqual([]);
  });
});

describe('wordErrors', () => {
  it('matches the classic example', () => {
    const r = wordErrors('the cat sat on the mat', 'the cat sit on mat');
    expect(r.subs).toBe(1);
    expect(r.dels).toBe(1);
    expect(r.ins).toBe(0);
    expect(r.hits).toBe(4);
    expect(r.wer).toBeCloseTo(2 / 6);
    expect(r.mer).toBeCloseTo(2 / 6);
    expect(r.wip).toBeCloseTo((4 / 6) * (4 / 5));
    expect(r.wil).toBeCloseTo(1 - (4 / 6) * (4 / 5));
    expect(topConfusions(r.ops)).toContainEqual({ op: 'sub', ref: 'sat', hyp: 'sit', count: 1 });
  });
  it('can exceed 1 with many insertions', () => {
    expect(wordErrors('hi', 'hi there you all').wer).toBe(3);
  });
  it('defines empty references', () => {
    expect(wordErrors('', '').wer).toBe(0);
    expect(wordErrors('', 'extra words').wer).toBe(1);
    expect(wordErrors('', '').wip).toBe(1);
  });
  it('applies a normalizer profile to both sides', () => {
    expect(wordErrors('Hello, World!', 'hello world', { profile: 'basic' }).wer).toBe(0);
    expect(wordErrors('Hello, World!', 'hello world').wer).toBe(1);
  });
});

describe('charErrors', () => {
  it('computes CER over characters', () => {
    const r = charErrors('abcd', 'abxd');
    expect(r.cer).toBeCloseTo(0.25);
    expect(r.refChars).toBe(4);
  });
  it('can ignore spaces for CJK text', () => {
    expect(charErrors('今天 天气', '今天天气', { ignoreSpaces: true }).cer).toBe(0);
    expect(charErrors('今天 天气', '今天天气').cer).toBeGreaterThan(0);
  });
});

describe('normalizeText', () => {
  it('basic strips punctuation and case but keeps in-word apostrophes', () => {
    expect(normalizeText("Hello,   WORLD! It's — fine.", 'basic')).toBe("hello world it's fine");
  });
  it('english expands contractions, numbers, symbols and fillers', () => {
    expect(normalizeText("Um, I can't pay twenty-five dollars", 'english')).toBe('i can not pay 25 dollars');
    expect(normalizeText('$25 is 50% off the colour [noise]', 'english')).toBe('25 dollars is 50 percent off the color');
    expect(normalizeText('one hundred and two', 'english')).toBe('102');
    expect(normalizeText('pi is 3.14', 'english')).toBe('pi is 3.14');
  });
  it('custom applies rules then substitutions after a base profile', () => {
    const out = normalizeText('Mr. Smith said OK', 'custom', {
      base: 'basic',
      rules: [{ pattern: '\\bmr\\b', replace: 'mister' }],
      substitutions: { ok: 'okay' },
    });
    expect(out).toBe('mister smith said okay');
  });
  it('none leaves text unchanged', () => {
    expect(normalizeText('A, b', 'none')).toBe('A, b');
  });
});

describe('text metrics', () => {
  it('levenshtein similarity', () => {
    expect(levenshteinSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
    expect(levenshteinSimilarity('', '')).toBe(1);
  });
  it('BLEU: identical = 1, disjoint ≈ 0, partial in between', () => {
    const s = 'the quick brown fox jumps over the lazy dog';
    expect(sentenceBleu(s, s).score).toBeCloseTo(1);
    expect(sentenceBleu(s, 'completely different words appear in this output').score).toBeLessThan(0.1);
    const partial = sentenceBleu(s, 'the quick brown fox jumped over a lazy dog').score;
    expect(partial).toBeGreaterThan(0.2);
    expect(partial).toBeLessThan(1);
  });
  it('BLEU uses the best of several references', () => {
    const one = sentenceBleu('a cat is on the mat', 'the cat is on the mat').score;
    const two = sentenceBleu(['a cat is on the mat', 'the cat is on the mat'], 'the cat is on the mat').score;
    expect(two).toBeGreaterThan(one);
    expect(two).toBeCloseTo(1);
  });
  it('ROUGE-L', () => {
    const r = rougeL('the cat sat on the mat', 'the cat on the mat');
    expect(r.recall).toBeCloseTo(5 / 6);
    expect(r.precision).toBe(1);
  });
  it('token F1 and exact match', () => {
    expect(tokenF1('The Eiffel Tower', 'eiffel tower!').f1).toBe(1);
    expect(exactMatch('The Eiffel Tower', 'eiffel tower')).toBe(true);
    const r = tokenF1('paris france', 'paris');
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(0.5);
  });
  it('chrF', () => {
    expect(chrF('hello world', 'hello world')).toBeCloseTo(1);
    expect(chrF('hello world', 'xyz')).toBe(0);
    expect(chrF('hello world', 'hello word')).toBeGreaterThan(0.5);
  });
});
