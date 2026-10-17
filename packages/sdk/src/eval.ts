/*
 * `kalibra-sdk/eval`: evals as code. Re-exported from the main entry so both share one SDK state
 * (traces your task produces are linked to the eval rows). See evaluate.ts.
 */

export { evaluate, KalibraEvalError, toOutputs } from './index.js';
export type { EvaluateOptions, EvaluateResult, EvalRow } from './index.js';
