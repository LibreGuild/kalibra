import { z } from 'zod';
import { defineOp } from '../registry.js';
import { invalid, parseJson } from '../util.js';
import { fileSize } from '../storage.js';
import { join } from 'node:path';

export const workspaceOps = [
  defineOp({
    name: 'get_workspace',
    title: 'Get workspace info',
    description: 'Workspace location, counts of datasets/targets/suites/runs and storage used.',
    category: 'workspace',
    readOnly: true,
    input: z.object({}),
    handler: async ({ engine, caps }) => {
      const count = (sql: string) => engine.db.get(sql).n as number;
      const blobs = engine.db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs');
      return {
        dir: caps.showPaths ? engine.dir : undefined,
        datasets: count('SELECT COUNT(*) AS n FROM datasets WHERE deleted_at IS NULL'),
        rows: count('SELECT COUNT(*) AS n FROM rows WHERE deleted_at IS NULL'),
        targets: count("SELECT COUNT(*) AS n FROM defs WHERE kind = 'target' AND deleted_at IS NULL"),
        suites: count("SELECT COUNT(*) AS n FROM defs WHERE kind = 'suite' AND deleted_at IS NULL"),
        connections: count("SELECT COUNT(*) AS n FROM defs WHERE kind = 'connection' AND deleted_at IS NULL"),
        runs: count('SELECT COUNT(*) AS n FROM runs WHERE deleted_at IS NULL'),
        storage: {
          databaseBytes: (await fileSize(join(engine.dir, 'kalibra.db'))) + (await fileSize(join(engine.dir, 'kalibra.db-wal'))),
          blobCount: blobs.n,
          blobBytes: blobs.bytes,
        },
      };
    },
  }),

  defineOp({
    name: 'list_operations',
    title: 'List operations',
    description: 'Every operation Kalibra supports, with its input schema. The UI, CLI and MCP tools are built from this list.',
    category: 'workspace',
    readOnly: true,
    input: z.object({}),
    handler: ({ engine }) => engine.registry.describe(),
  }),

  defineOp({
    name: 'list_activity',
    title: 'Recent activity',
    description: 'Recent changes with who made them (you, a coding agent over MCP, or the CLI).',
    category: 'workspace',
    readOnly: true,
    input: z.object({ limit: z.number().int().min(1).max(500).default(50), actorKind: z.enum(['user', 'agent', 'cli', 'system']).optional() }),
    handler: ({ engine }, i) =>
      engine.db
        .all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', i.actorKind ? 500 : i.limit)
        .map((a) => ({ id: a.id, at: a.at, op: a.op, summary: a.summary, actor: parseJson<any>(a.actor, {}) }))
        .filter((a) => !i.actorKind || a.actor.kind === i.actorKind)
        .slice(0, i.limit),
  }),

  defineOp({
    name: 'upload_file',
    title: 'Upload a small file',
    description:
      'Stores a file (base64, up to ~15 MB) and returns its blob hash, to use in file-typed dataset columns ({ blob: hash }) or with import_rows. The UI uploads large files over HTTP instead.',
    category: 'workspace',
    quiet: true,
    input: z.object({ name: z.string(), base64: z.string(), mime: z.string().optional() }),
    handler: async ({ engine }, i) => {
      const data = Buffer.from(i.base64, 'base64');
      if (!data.length) throw invalid('Empty file');
      return engine.blobs.put(data, { name: i.name, mime: i.mime });
    },
  }),

  defineOp({
    name: 'get_file_info',
    title: 'Get file info',
    description: 'Name, size and type of an uploaded file.',
    category: 'workspace',
    readOnly: true,
    input: z.object({ hash: z.string() }),
    handler: ({ engine }, i) => engine.blobs.info(i.hash) ?? null,
  }),
];
