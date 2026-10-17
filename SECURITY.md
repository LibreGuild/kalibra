# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Until that is enabled for this repository, contact a LibreGuild maintainer directly on GitHub.

Include what you found, how to reproduce it, and the version (shown in the app's profile menu or `kalibra --help`). We aim to reply within a week and to fix confirmed issues in the next release.

## Supported versions

Only the latest release, including the latest pre-release (`next`), gets security fixes.

## Scope notes

- Script targets, hooks and script checks run JavaScript with the permissions of the machine Kalibra runs on; this is by design. On team servers, only administrators may add code by default (`codePolicy`).
- How sign-in, sessions, tokens and permissions work is described in [docs/users-and-projects.md](docs/users-and-projects.md).
