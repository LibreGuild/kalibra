# @kalibra/web

The web UI, used by `npx kalibra` and team servers alike: React 19, Vite, Tailwind 4, Radix, TanStack Query/Virtual, CodeMirror. It only talks to the HTTP API; every action is an operation call (`op('create_dataset', …)`), so anything the UI does, the CLI and agents can do too.

## Code map

| Path | Owns |
|---|---|
| `src/main.tsx`, `src/routes.tsx` | start-up and every route: `/p/:project/*` for project pages; `/projects`, `/account`, `/admin/*`, `/docs`, `/settings`, `/login`, `/setup` outside projects; `/sdk-docs/*` outside the sign-in gate. Pages load on first use (`page()` in routes.tsx), so the first screen downloads only the app frame |
| `src/lib/api.ts` | calling operations (`op`, `useOp`, `useOpMutation`, `hubOp`, `useHubOp`), uploads, file URLs, live events (which query keys each event refreshes: `INVALIDATE`), auth status |
| `src/lib/session.tsx` | sign-in gate, the current project and your role (`useProject`, `useCanEdit`, `CanEdit`, `useCanWriteCode`) |
| `src/lib/nav.tsx` | `Link` / `useNavigate` that put app paths under the current project |
| `src/lib/theme.tsx` | theme, reading font, text size (the brand colour is fixed in `styles.css`) |
| `src/lib/format.ts`, `src/lib/roles.ts` | formatting (numbers, times, who did something) and role labels |
| `src/pages/` | one file per page: datasets, targets, suites, runs (+ compare), run-group (comparisons), calibrate, playground, connections, projects (+ project settings), account, admin, auth (sign-in, setup), agents, docs, settings, overview |
| `src/components/<area>/` | the parts of those pages: `datasets/` (row sheet, columns editor, Generate dialogs, Quality tab), `targets/` (forms per kind, try panel), `suites/` (check cards), `runs/` (dialogs, result sheet, themes, breakdown), `traces/`, `playground/`, `sharing/`, `calibrate/`, `admin/`, `docs/`, `layout/` (shell, sidebar, project switcher) |
| `src/components/ui/` | the shared building blocks: buttons, form fields, dialogs, menus, tooltips, tables, toasts, code editor, media players. Reuse these instead of styling from scratch. |
| `src/styles.css` | theme tokens (colours per light/dark and accent) and base styles |
| `src/docs/content.ts` | the in-app guides (Docs page); illustrations in `public/docs/` |
| `src/sdk-docs/` | the public SDK docs at `/sdk-docs/javascript` and `/sdk-docs/python` (outside the sign-in gate, no API calls): `content.ts` holds every section for both languages, `page.tsx` renders it, `brief.ts` is the two cards of the profile menu's picker (kept apart so the menu stays small); tested in `test/sdk-docs.test.ts` |

## Run and test

- `npm run dev` from the repo root starts the engine and Vite (http://localhost:5173/kalibra/), with hot reload. The app is built with Vite `base: '/kalibra/'`; raw URLs go through `withBase()` (`src/lib/base.ts`), router paths don't (React Router's `basename`).
- `npx tsc -p packages/web` typechecks; `npm run build -w @kalibra/web` builds into `dist/`, which the CLI serves (and bundles for npm and Docker).

## Where to start

- **A new page:** add a lazy route (`...page(() => import('./pages/x'), (m) => m.XPage)`) in `src/routes.tsx`, the page in `src/pages/`, and a sidebar entry in `src/components/layout/shell.tsx`.
- **A new action:** call its operation with `useOpMutation('op_name', { invalidate: [...] })`. If agents or other tabs change the same data, add the query keys to `INVALIDATE` in `lib/api.ts`.
- **A new check or target option:** usually no UI work. Check forms are generated from the check's `fields` in core; target forms live in `components/targets/`.
- **Colours:** use the theme tokens (`text-ink-muted`, `bg-raised`, `text-accent-ink`, …) from `styles.css`, never hard-coded colours.
