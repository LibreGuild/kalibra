import { spawn } from 'node:child_process';

/** `npm run dev`: engine (port 4317, workspace ./.kalibra-dev) + Vite UI (5173) + demo apps (4400). */
const procs = [
  ['engine', 'npx', ['tsx', 'watch', '--clear-screen=false', 'packages/cli/src/main.ts', 'serve', '--dev']],
  ['web', 'npm', ['run', 'dev', '-w', '@kalibra/web']],
  ['demo', 'npx', ['tsx', 'packages/demo/src/main.ts', ...(process.argv.includes('--seed') ? ['--seed'] : [])]],
];
const colors = { engine: 33, web: 36, demo: 35 };
const children = procs.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const tag = `\x1b[${colors[name]}m${name.padEnd(6)}\x1b[0m│ `;
  const out = (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n');
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  return child;
});
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Kalibra dev: UI http://localhost:5173  (engine :4317, demo apps :4400). Seed demo data with: npm run demo -- --seed');
