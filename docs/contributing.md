# Contributing

## Style

- Match the surrounding code: naming, idioms, comment density.
- Files open with a short header comment explaining *why* the module exists; no comment noise elsewhere.
- TypeScript strict. ESM with `.js` extensions in relative imports inside `core`.
- UI: theme tokens only (`bg-surface`, `text-ink-muted`, `border-line`, `bg-accent`…), rem text sizes, a `HelpTip` on anything non-obvious, no horizontal page scroll.
- Never block a user: if you add a structured option, think about the script escape hatch.

## Add an operation

1. Write `defineOp({...})` in the right `packages/core/src/ops/*.ts` (or a new file registered in `ops/index.ts`).
2. Give it a clear `description`; agents read it.
3. Mark `readOnly` or `destructive` correctly; use `quiet` for helper ops.
4. Emit an event if the UI should refresh, and add the event to `INVALIDATE` in `web/src/lib/api.ts` if it is new.
5. Add a test with an `Engine` on a temp folder.

## Add a check type

1. `defineCheck({ type, label, category, layer, description, config: z.object(...), fields, run })` in `packages/core/src/checks/`.
2. Register it in `checks/index.ts`.
3. Write `fields[].help` for non-experts; the suite editor renders the form from `fields`.
4. For corpus-level metrics, return `details.errors` and `details.refUnits`.

## Add a target kind

1. Add a zod schema to the `TargetSpec` union in `specs.ts`.
2. Implement an executor in `packages/core/src/targets/` returning `TargetCallResult` (never throw; set `retryable`).
3. Dispatch it in `targets/index.ts`.
4. Add a form in `web/src/components/targets/` and a default in `components/targets/model.ts`.

## Add a UI page

1. Create `web/src/pages/<name>.tsx` using `Page`, `Card`, `SectionTitle` and the shared ui components.
2. Register the route in `web/src/routes.tsx` and, if needed, a nav item in `components/layout/shell.tsx`.
3. Read data with `useOp(name, input)`; write with `useOpMutation(name, { invalidate })`.
4. Add an in-app guide in `web/src/docs/content.ts` if users need to learn it.

## Before you commit

```bash
npm run typecheck && npm test
```

Commit messages: imperative summary line, then a short body listing what changed and why.
