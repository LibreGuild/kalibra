import { z } from 'zod';
import { defineOp, type OpDef } from '../registry.js';
import { ConversationSettings, TargetSpec } from '../specs.js';
import { runConversation } from '../runner/conversation.js';
import { callTarget } from '../runner/runner.js';
import type { LogEntry } from '../script.js';
import { invalid } from '../util.js';

export const conversationsOps: OpDef<any, any>[] = [
  defineOp({
    name: 'test_conversation',
    title: 'Try a conversation',
    description:
      'Runs one multi-turn conversation against a target without creating a run, and returns the transcript. Scripted mode sends the user messages from a list column (e.g. "turns"); simulated mode lets a model play the user from a persona and goal. Works with unsaved target specs.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      target: z.string().optional().describe('Saved target id or name'),
      spec: z.record(z.string(), z.unknown()).optional().describe('Unsaved target spec (overrides target)'),
      dataset: z.string().optional(),
      rowId: z.string().optional().describe('Row to use; defaults to the first row of the dataset'),
      values: z.record(z.string(), z.unknown()).optional().describe('Row values to use instead of a dataset row, e.g. { turns: ["Hi", "Block my card"] }'),
      conversation: ConversationSettings,
    }),
    handler: async ({ engine }, i) => {
      if (i.conversation.mode === 'off') throw invalid('Choose "scripted" or "simulated" conversation mode');
      const spec = TargetSpec.parse(i.spec ?? (i.target ? engine.repos.defs.get('target', i.target).spec : undefined));
      let row: Record<string, unknown> = i.values ?? {};
      let rowId = 'manual';
      if (!i.values && (i.rowId || i.dataset)) {
        const r = i.rowId ? engine.repos.datasets.getRow(i.rowId) : engine.repos.datasets.listRows(engine.repos.datasets.get(i.dataset!).id, { limit: 1 }).rows[0];
        if (!r) throw invalid('The dataset has no rows yet');
        row = r.data;
        rowId = r.id;
      }
      const vars = Object.fromEntries(spec.variables.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]));
      const logs: LogEntry[] = [];
      const log = (level: LogEntry['level'], message: string) => logs.push({ at: Date.now(), level, message });
      const signal = AbortSignal.timeout(300_000);
      const { result } = await runConversation(i.conversation, row, {
        call: (r) => callTarget(engine, spec, { row: r, rowId, vars, retries: 0, signal, log }),
        llm: engine.llm,
        env: engine.templateEnv(),
        signal,
        log,
      });
      return { ...result, rowId, row, logs: [...result.logs, ...logs] };
    },
  }),
];
