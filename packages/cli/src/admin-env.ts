/**
 * The first administrator from KALIBRA_ADMIN_USERNAME / KALIBRA_ADMIN_PASSWORD. Values mounted from
 * secret managers (Secret Manager, Kubernetes secrets, files) often end with a newline that nobody
 * typed; it is dropped, so the password people sign in with is the one they see. Other spaces stay.
 */
export function adminFromEnv(env: Record<string, string | undefined> = process.env): { username: string; password: string } | undefined {
  const username = env.KALIBRA_ADMIN_USERNAME?.trim();
  const password = env.KALIBRA_ADMIN_PASSWORD?.replace(/[\r\n]+$/, '');
  return username && password ? { username, password } : undefined;
}
