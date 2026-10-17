/*
 * The SDK never throws into your code. Problems (Kalibra unreachable, a bad key, a full queue) are
 * reported once each to stderr and otherwise ignored.
 */

const said = new Set<string>();
let enabled = true;

export function setWarnings(on: boolean) {
  enabled = on;
}

export function warnOnce(key: string, message: string) {
  if (!enabled || said.has(key)) return;
  said.add(key);
  try {
    process.stderr.write(`[kalibra-sdk] ${message}\n`);
  } catch {
    /* nowhere to report */
  }
}

/** For tests. */
export function resetWarnings() {
  said.clear();
}
