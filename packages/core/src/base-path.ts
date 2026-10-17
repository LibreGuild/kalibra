/**
 * Every Kalibra address starts with this path: the UI (/kalibra/), the API (/kalibra/api/…), sign-in,
 * live events, files, ingest, OpenTelemetry and the OpenAI proxy. One prefix lets a load balancer in
 * front of a team server route on the path. The web UI (vite `base`) and the SDKs keep their own copy.
 */
export const BASE_PATH = '/kalibra';

/**
 * The origin from a configured public address. People may paste it with the base path
 * ("https://kalibra.example.com/kalibra/"); Kalibra adds the base path itself.
 */
export function publicOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith(BASE_PATH) ? trimmed.slice(0, -BASE_PATH.length) : trimmed;
}
