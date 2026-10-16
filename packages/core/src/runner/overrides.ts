import { TargetSpec, type RunOverrides } from '../specs.js';

/*
 * Run overrides change a target for one run without editing (or versioning) the target itself.
 * They are stored in the run's settings, so a comparison stays reproducible.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  if (!isPlainObject(base)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function applyOverrides(spec: TargetSpec, o?: RunOverrides): TargetSpec {
  if (!o) return spec;
  let next: TargetSpec = { ...spec, variables: spec.variables.map((v) => ({ ...v })) };

  for (const [key, value] of Object.entries(o.vars ?? {})) {
    const existing = next.variables.find((v) => v.key === key);
    if (existing) {
      existing.value = value;
      existing.enabled = true;
    } else next.variables.push({ key, value, enabled: true });
  }

  if (o.config && Object.keys(o.config).length) {
    next = { ...next, config: deepMerge(next.config, o.config) };
  }

  if (o.model && next.config.kind === 'model') {
    next = {
      ...next,
      config: {
        ...next.config,
        ...(o.model.connectionId ? { connectionId: o.model.connectionId } : {}),
        ...(o.model.model ? { model: o.model.model } : {}),
        ...(o.model.temperature !== undefined ? { temperature: o.model.temperature } : {}),
      },
    };
  }
  // Re-validate so a bad override fails loudly instead of producing odd requests.
  return TargetSpec.parse(next);
}
