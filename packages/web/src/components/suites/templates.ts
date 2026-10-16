import { newCheckId, type CheckSpec } from './check-card';

/** Starting points for new suites. Configs only set what differs from each check type's defaults. */
export interface SuiteTemplate {
  id: string;
  label: string;
  description: string;
  build: () => CheckSpec[];
}

const check = (type: string, config: Record<string, unknown> = {}, patch: Partial<CheckSpec> = {}): CheckSpec => ({
  id: newCheckId(),
  type,
  name: '',
  enabled: true,
  gate: false,
  weight: 1,
  applyWhen: '',
  config,
  ...patch,
});

export const SUITE_TEMPLATES: SuiteTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'Start empty and add checks yourself.',
    build: () => [],
  },
  {
    id: 'http_json',
    label: 'HTTP JSON API',
    description: 'Status and JSON gates, a field check, a phrase check and a latency limit.',
    build: () => [
      check('status', { expected: '2xx' }, { gate: true, name: 'Status is 2xx' }),
      check('is_json', { actual: '{{response.text}}' }, { gate: true, name: 'Response is JSON' }),
      check('jsonpath', { actual: '{{response.body}}', path: '$.answer', operator: 'exists' }, { name: 'Has an answer field' }),
      check('contains', { actual: '{{output}}', values: [], mode: 'any' }, { name: 'Mentions expected phrases', enabled: false }),
      check('latency', { metric: 'latency_ms', max: 3000 }, { name: 'Responds within 3 s' }),
    ],
  },
  {
    id: 'stt',
    label: 'Speech-to-text',
    description: 'No-error gate, WER ≤ 15% against {{reference}}, keyword recall and final latency.',
    build: () => [
      check('no_error', {}, { gate: true, name: 'Call succeeded' }),
      check('wer', { actual: '{{output}}', reference: '{{reference}}', metric: 'wer', normalizer: 'english', max: 0.15 }, { name: 'WER ≤ 15%' }),
      check('keyword_recall', { actual: '{{output}}', keywords: '{{keywords}}', minRecall: 1 }, { name: 'All keywords heard', applyWhen: 'Array.isArray(row.keywords) ? row.keywords.length > 0 : !!row.keywords' }),
      check('latency', { metric: 'final_latency_ms', max: 1000 }, { name: 'Final transcript within 1 s' }),
    ],
  },
  {
    id: 'llm_quality',
    label: 'LLM output quality',
    description: 'An LLM judge with a pass/fail rubric. Pick a connection to enable it.',
    build: () => [
      check('no_error', {}, { gate: true, name: 'Call succeeded' }),
      check('llm_judge', {}, { name: 'Judge: answers the question well', enabled: false }),
    ],
  },
];
