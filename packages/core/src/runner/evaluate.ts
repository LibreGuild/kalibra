import { getCheckType } from '../checks/index.js';
import type { CheckResult, CheckScope } from '../checks/types.js';
import { evalExpression } from '../script.js';
import type { SuiteSpec } from '../specs.js';

/**
 * Runs a suite's checks in layer order. When a gate fails, every check in a later layer is
 * skipped, so a schema failure never pays for an LLM judge and the failure reason stays clear.
 */
export async function evaluateChecks(suite: SuiteSpec, ctx: CheckScope): Promise<{ checks: CheckResult[]; passed: boolean; score: number | null }> {
  const enabled = suite.checks.filter((c) => c.enabled);
  const ordered = enabled
    .map((spec, index) => ({ spec, index, type: getCheckType(spec.type) }))
    .sort((a, b) => (a.type?.layer ?? 5) - (b.type?.layer ?? 5) || a.index - b.index);

  const results: CheckResult[] = [];
  let blockedBy: { name: string; layer: number } | null = null;

  for (const { spec, type } of ordered) {
    const layer = type?.layer ?? 5;
    const base = { id: spec.id, type: spec.type, name: spec.name || type?.label || spec.type, layer, gate: spec.gate, weight: spec.weight };
    const started = Date.now();

    if (!type) {
      results.push({ ...base, status: 'error', reason: `Unknown check type "${spec.type}"`, durationMs: 0 });
      continue;
    }
    if (blockedBy && layer > blockedBy.layer) {
      results.push({ ...base, status: 'skip', reason: `Skipped: gate "${blockedBy.name}" failed`, durationMs: 0 });
      continue;
    }
    if (spec.applyWhen.trim()) {
      let applies = false;
      try {
        applies = !!evalExpression(spec.applyWhen, ctx.scope);
      } catch (e: any) {
        results.push({ ...base, status: 'error', reason: `applyWhen failed: ${e.message}`, durationMs: Date.now() - started });
        continue;
      }
      if (!applies) {
        results.push({ ...base, status: 'skip', reason: 'Not applicable (applyWhen is false)', durationMs: 0 });
        continue;
      }
    }

    let outcome;
    try {
      const config = type.config.parse(spec.config ?? {});
      outcome = await type.run(config, ctx);
    } catch (e: any) {
      outcome = { status: 'error' as const, reason: e?.message ?? String(e) };
    }
    results.push({ ...base, ...outcome, durationMs: Date.now() - started });
    if (spec.gate && outcome.status !== 'pass' && outcome.status !== 'skip' && !blockedBy) {
      blockedBy = { name: base.name, layer };
    }
  }

  const counted = results.filter((r) => r.status !== 'skip' || r.reason?.startsWith('Skipped: gate'));
  if (counted.length === 0) return { checks: results, passed: true, score: null };

  const weightSum = counted.reduce((s, r) => s + r.weight, 0) || 1;
  const score = counted.reduce((s, r) => s + r.weight * (r.status === 'pass' ? (r.score ?? 1) : r.status === 'skip' ? 0 : Math.min(r.score ?? 0, 1)), 0) / weightSum;
  const passed =
    suite.passRule === 'weighted'
      ? score >= suite.passThreshold && !results.some((r) => r.gate && (r.status === 'fail' || r.status === 'error'))
      : counted.every((r) => r.status === 'pass');
  return { checks: results, passed, score: Math.round(score * 10000) / 10000 };
}
