import { z } from 'zod';
import { defineOp, type OpDef } from '../registry.js';
import { exportBundle, importBundle, inspectBundle } from '../sharing/bundle.js';
import { exportToFolder, importFromFolder } from '../sharing/folder.js';
import { importExternal, inspectExternal } from '../sharing/importers.js';
import { settingsGet, settingsSet, type CodeItem } from '../sharing/common.js';
import { invalid, KalibraError } from '../util.js';
import { allowedFolder } from '../policy.js';
import type { Engine } from '../engine.js';

/*
 * Team sharing without a server: bundles to send to a teammate, a Git-friendly folder to sync,
 * and importers for other eval tools. Secret values are never exported.
 */

/** Imports that would add code are refused as a whole where only administrators may add code. */
function refuseCode(code: CodeItem[], source: string) {
  if (!code.length) return;
  const list = code.map((c) => `${c.kind} "${c.name}"`).join(', ');
  throw new KalibraError('forbidden', `${source} contains JavaScript (${list}). On this server only administrators can import code.`);
}

async function blobBytes(engine: Engine, hash: string) {
  if (!(await engine.blobs.info(hash)) || !(await engine.blobs.has(hash))) throw invalid('Upload the file first (blob not found)');
  return new Uint8Array(await engine.blobs.get(hash));
}

export const sharingOps: OpDef<any, any>[] = [
  defineOp({
    name: 'export_bundle',
    title: 'Export a bundle',
    description:
      'Packs datasets (with their audio/image files), targets, suites, connections and optionally runs into one .kalibra file a teammate can import. Secret values are never included — only the names of secrets they need to set. Pass everything: true for the whole workspace. Returns the file (blob hash) to download.',
    category: 'workspace',
    // Packing up what you can already read; viewers may take a copy.
    access: 'viewer',
    input: z.object({
      datasets: z.array(z.string()).optional(),
      targets: z.array(z.string()).optional(),
      suites: z.array(z.string()).optional(),
      connections: z.array(z.string()).optional(),
      runs: z.array(z.string()).optional().describe('Runs to include with all their results (their dataset, target and suite come along)'),
      everything: z.boolean().default(false).describe('All datasets, targets, suites and connections'),
      includeRuns: z.boolean().default(false).describe('With everything: also include every run'),
      includeMedia: z.boolean().default(true),
      name: z.string().optional(),
    }),
    handler: async ({ engine }, i) => {
      const { bytes, manifest } = await exportBundle(engine, i);
      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `${(i.name || manifest.contents.datasets[0]?.name || 'kalibra').replace(/[^\w.-]+/g, '-')}-${stamp}.kalibra`;
      const blob = await engine.blobs.put(bytes, { mime: 'application/zip', name: fileName });
      return { ...blob, manifest };
    },
  }),

  defineOp({
    name: 'inspect_bundle',
    title: 'Inspect a bundle',
    description: 'Reads an uploaded .kalibra bundle without importing it: what it contains, which items already exist here, and which secrets you would need to set.',
    category: 'workspace',
    readOnly: true,
    input: z.object({ blob: z.string() }),
    handler: async ({ engine }, i) => inspectBundle(engine, await blobBytes(engine, i.blob)),
  }),

  defineOp({
    name: 'import_bundle',
    title: 'Import a bundle',
    description:
      'Imports an uploaded .kalibra bundle. When something with the same name exists: rename (keep both), skip (keep yours) or new_version (update yours; datasets get the new rows). Files are deduplicated, run references are rewired, and the report lists secrets to set.',
    category: 'workspace',
    input: z.object({ blob: z.string(), onConflict: z.enum(['rename', 'skip', 'new_version']).default('rename') }),
    handler: async ({ engine, actor, caps }, i) => {
      const bytes = await blobBytes(engine, i.blob);
      // Refuse up front rather than stopping halfway through an import.
      if (!caps.code) refuseCode((await inspectBundle(engine, bytes)).code, 'This bundle');
      return importBundle(engine, bytes, i.onConflict, actor);
    },
  }),

  defineOp({
    name: 'get_sharing_settings',
    title: 'Get sharing settings',
    description: 'The folder used for Git sync and when it was last exported or imported.',
    category: 'workspace',
    readOnly: true,
    input: z.object({}),
    handler: async ({ engine }) => await settingsGet(engine),
  }),

  defineOp({
    name: 'set_sharing_settings',
    title: 'Set sharing settings',
    description: 'Remembers the Git sync folder and options.',
    category: 'workspace',
    access: 'owner',
    quiet: true,
    input: z.object({ folder: z.string().optional(), includeRows: z.boolean().optional(), includeMedia: z.boolean().optional() }),
    handler: async ({ engine }, i) => await settingsSet(engine, i),
  }),

  defineOp({
    name: 'export_to_folder',
    title: 'Export to a folder',
    description:
      'Writes targets, suites, connections (no secrets) and datasets as small, stable text files in a folder your team keeps in Git. Re-exporting only changes files whose content changed. Takes an absolute path on the computer Kalibra runs on.',
    category: 'workspace',
    // Writes to a folder on the engine's machine.
    access: 'owner',
    input: z.object({ dir: z.string(), includeRows: z.boolean().default(true), includeMedia: z.boolean().default(false).describe('Also copy audio/image files (large; usually left out of Git)') }),
    handler: (ctx, i) => exportToFolder(ctx.engine, allowedFolder(ctx, i.dir), i),
  }),

  defineOp({
    name: 'import_from_folder',
    title: 'Import from a folder',
    description:
      'Reads a Kalibra folder (e.g. after git pull) and applies differences: new items are added, changed definitions get a new version, changed rows are updated. Use dryRun to preview. Nothing is deleted unless prune is true. Takes an absolute path on this computer.',
    category: 'workspace',
    access: 'owner',
    input: z.object({ dir: z.string(), dryRun: z.boolean().default(false), prune: z.boolean().default(false).describe('Also delete items and rows that are not in the folder') }),
    handler: async (ctx, i) => {
      const dir = allowedFolder(ctx, i.dir);
      if (!ctx.caps.code && !i.dryRun) refuseCode((await importFromFolder(ctx.engine, dir, { ...i, dryRun: true }, ctx.actor)).code, 'This folder');
      return importFromFolder(ctx.engine, dir, i, ctx.actor);
    },
  }),

  defineOp({
    name: 'inspect_external',
    title: 'Detect an import file',
    description: 'Detects what an uploaded file is (Kalibra bundle, promptfoo config, OpenAI Evals JSONL, LangSmith or Langfuse export, or a plain CSV/JSONL) and summarises it, without importing.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ blob: z.string() }),
    handler: async ({ engine }, i) => inspectExternal(await blobBytes(engine, i.blob), (await engine.blobs.info(i.blob))?.name ?? ''),
  }),

  defineOp({
    name: 'import_external',
    title: 'Import from another eval tool',
    description:
      'Imports a promptfoo config (tests → dataset, assertions → suite, http/model providers → targets), an OpenAI Evals JSONL (plus optional graders), or a LangSmith / Langfuse dataset export. The report lists what was mapped and what was not.',
    category: 'datasets',
    input: z.object({
      blob: z.string(),
      format: z.enum(['auto', 'promptfoo', 'openai_evals', 'langsmith', 'langfuse']).default('auto'),
      name: z.string().optional().describe('Name for the new dataset (default: from the file)'),
      gradersBlob: z.string().optional().describe('OpenAI Evals only: an uploaded JSON file with testing_criteria / graders'),
    }),
    handler: async ({ engine, actor }, i) => {
      const bytes = await blobBytes(engine, i.blob);
      let graders: unknown;
      if (i.gradersBlob) {
        try {
          graders = JSON.parse(Buffer.from(await blobBytes(engine, i.gradersBlob)).toString('utf8'));
        } catch {
          throw invalid('The graders file is not valid JSON');
        }
      }
      const fileName = (await engine.blobs.info(i.blob))?.name ?? '';
      return await importExternal(engine, bytes, { format: i.format, name: i.name || fileName.replace(/\.[^.]+$/, '') || undefined, fileName, graders }, actor);
    },
  }),
];
