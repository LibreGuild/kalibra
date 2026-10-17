/*
 * Kalibra serves everything under one path, /kalibra (BASE_PATH in packages/core/src/base-path.ts),
 * so a load balancer can route on it. Vite's `base` sets it for the built app; router paths stay
 * app-relative ("/runs") and React Router adds the base. Raw URLs (fetch, <a href>, <img src>,
 * EventSource, window.location) go through withBase().
 */

/** "/kalibra" (no trailing slash). */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/** An app path or server path ("/api/meta", "/logo.png", "/login") as the browser must request it. */
export const withBase = (path: string) => (path.startsWith('/') ? `${BASE}${path}` : path);
