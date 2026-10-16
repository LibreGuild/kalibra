import type { OpDef } from '../registry.js';
import { datasetOps } from './datasets.js';
import { defOpsAll } from './defs.js';
import { insightOps } from './insights.js';
import { labelOps } from './labels.js';
import { mediaOps } from './media.js';
import { runOps } from './runs.js';
import { safetyOps } from './safety.js';
import { workspaceOps } from './workspace.js';

export const ALL_OPS: OpDef<any, any>[] = [...workspaceOps, ...datasetOps, ...mediaOps, ...safetyOps, ...defOpsAll, ...runOps, ...insightOps, ...labelOps];
