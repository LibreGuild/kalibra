/* The SDK cards' text, separate from content.ts so the profile menu's SDK docs dialog stays small. */

/** What each SDK is for, in two sentences (the "SDK docs" picker in the app). */
export const SDK_BRIEF: Record<'js' | 'python', { name: string; install: string; text: string }> = {
  js: {
    name: 'JavaScript / TypeScript',
    install: 'npm i kalibra-sdk',
    text: 'For Node.js apps: Express, Next.js, Hono, Fastify, workers. Traces and steps, links to eval runs, tool record/replay, and evaluate() in vitest or jest.',
  },
  python: {
    name: 'Python',
    install: 'pip install kalibra-sdk',
    text: 'For Python apps: FastAPI, Flask, Django, scripts and notebooks. Traces and steps, links to eval runs, tool record/replay, and evaluate() in pytest.',
  },
};
