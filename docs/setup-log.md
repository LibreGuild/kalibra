# Setup log: real sign-in tests (GitHub and Google)

What was set up in outside services on 2026-10-17 to test Kalibra's sign-in providers for real, how to rerun the test, and how to undo it. Secrets are **not** in this file; they are in `.env.local` at the repo root (git-ignored, permissions 0600).

## GitHub (github.com)

- **Where:** github.com → your account (sujithappikatla) → Settings → Developer settings → OAuth Apps → **Kalibra (local test)**.
- **Homepage URL:** `http://127.0.0.1:4330`
- **Callback URL:** `http://127.0.0.1:4330/api/auth/sso/github/callback`
- **Client ID and secret:** in `.env.local` (`KALIBRA_GITHUB_CLIENT_ID`, `KALIBRA_GITHUB_CLIENT_SECRET`). GitHub needed a passkey confirmation from you to create the secret.
- **Result:** ✅ Signed in with GitHub at 09:24; linked to the invited account `sujith` by your verified email.

## Google (GCP project "Cloud Learning", `cloud-learning-443407`)

- **Where:** console.cloud.google.com → Google Auth Platform.
- **Audience:** the app was already in **Testing** mode, External. I added **sujith.appikatla@gmail.com** as a test user; in Testing mode only listed test users can sign in.
- **Client:** Clients → **Kalibra (local test)**, type Web application.
  - Redirect URI: `http://127.0.0.1:4330/api/auth/sso/google/callback`
  - Client ID and secret: in `.env.local` (`KALIBRA_GOOGLE_CLIENT_ID`, `KALIBRA_GOOGLE_CLIENT_SECRET`).
- **Left as it was:** the existing client "VA" and the branding/consent settings.
- **Result:** ✅ Signed in with Google at 09:20; linked to the invited account `sujith` (Google reports the email as verified).

## How the test ran

```sh
npm run build
set -a; source .env.local; set +a
KALIBRA_ADMIN_USERNAME=admin KALIBRA_ADMIN_PASSWORD='<any 10+ chars>' \
  node packages/cli/dist/kalibra.mjs server --dir /tmp/kalibra-sso --port 4330 --public-url http://127.0.0.1:4330
```

1. Signed in as `admin` (Administration → Users) and invited **sujith** with email `sujith.appikatla@gmail.com` and no password. Providers are invite-only by default.
2. Opened `http://127.0.0.1:4330/login`, clicked **Continue with Google**, approved, and landed signed in as Sujith.
3. Signed out, clicked **Continue with GitHub**, approved, and landed signed in as Sujith again.
4. Administration → Users shows sujith with sign-in methods **github, google**. The Security log shows both logins with their provider.

The browser assistant cannot click on Google's or GitHub's sign-in and consent pages, so you clicked "Continue/Authorize" yourself.

## For a real deployment

- Create **new** OAuth apps/clients whose callback URLs use the real address (`https://kalibra.example.com/api/auth/sso/github/callback`, `…/google/callback`) and set `KALIBRA_PUBLIC_URL` to it.
- **Google:**
  - for a Google Workspace organisation, set the audience to **Internal**;
  - otherwise publish the app, or keep Testing and add up to 100 test users.
  - Add `KALIBRA_GOOGLE_DOMAINS=yourcompany.com` to let everyone at that domain in automatically.
- **GitHub:**
  - put the OAuth app under the **LibreGuild** organisation (org settings → Developer settings) rather than a personal account;
  - use `KALIBRA_GITHUB_ORGS=LibreGuild` to let org members in automatically.
- **GitHub Enterprise (e.g. the office one):** same steps on that server, plus `KALIBRA_GITHUB_URL=https://github.<company>.net`. Kalibra must run where it can reach that server.

## Undo

- **GitHub:** Settings → Developer settings → OAuth Apps → Kalibra (local test) → Advanced → **Delete application**.
- **Google:** Google Auth Platform → Clients → delete **Kalibra (local test)**; Audience → remove the test user if you don't need it.
- **Local:** delete `.env.local` and the scratch data folder used by the test server.
