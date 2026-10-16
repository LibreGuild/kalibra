import type { OpDef } from '../registry.js';
import { datasetOps } from './datasets.js';
import { defOpsAll } from './defs.js';
import { labelOps } from './labels.js';
import { mediaOps } from './media.js';
import { runOps } from './runs.js';
import { workspaceOps } from './workspace.js';

export const ALL_OPS: OpDef<any, any>[] = [...workspaceOps, ...datasetOps, ...mediaOps, ...defOpsAll, ...runOps, ...labelOps];
