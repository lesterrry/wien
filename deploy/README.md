# Backend releases

GitHub → Actions → **Release production** → **Run workflow** → choose a branch → Run.

Регистрация в вебе требует `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` и
`TURNSTILE_HOSTNAMES` в закрытом `/opt/wien/.env`. Эти значения передаются только
серверу; клиент получает публичный sitekey через `/auth/registration`.
Only `workflow_dispatch` deploys; pushes and pull requests do not deploy.
The workflow must first be merged into the repository's default branch for the
button to appear. The chosen branch supplies both source and server configs.

The runner builds `linux/amd64` server, RAG and web/nginx images, tags them with
`commit-run-attempt`, and transfers a release archive over SSH to `89.169.155.195`.
No registry login is needed. The VPS loads the ready images without compiling Rust.
Releases live in `/opt/wien/releases`; `current` and `previous` identify deployments.
A failed local health/readiness check triggers restoration of the previous release.
Readiness is checked on the VPS within the SSH deployment: `/ready` must succeed
both directly on the backend and through nginx with `Host: wien.aydar.media`;
unauthenticated assist must return 401 (503 is accepted for rollback to older releases),
and the removed `/v1/generate` must return 404 (503 is accepted for older releases). Any failure makes the SSH step fail.
The runner does not probe the public Cloudflare URL because Bot Fight Mode can
challenge automated requests. These checks cover the origin, not Cloudflare.
The receiver retains two successful releases and their images.

Production uses `deploy/compose.yaml`, not `just run-server` or the local Codex
override. `/opt/wien/.env` and external volume `wien_skill-data` remain on the VPS.
AI Tunnel credentials, PostgreSQL credentials and the RAG corpus are never uploaded to GitHub Actions.
Nginx serves HTTP behind Cloudflare; no certificates are created.
Public `/v1/assist` requires a session and a remaining assist allowance.
Nginx serves the browser app at `/`, caches hashed `/assets/`, and forwards
`/auth`, `/users`, `/v1`, `/docs`, `/health`, `/ready` and `/openapi.json` to the backend.
Authentication and quotas are enforced by the backend. Browser sessions use HttpOnly,
Secure, SameSite=Strict cookies; Electron continues using bearer tokens.
The web app stores projects only in browser IndexedDB; accounts do not sync files.
The same manual release deploys compatible server and web images together.
The legacy raw generation endpoint has been removed.
Bot Fight Mode is unchanged; if it challenges desktop requests, the client reports
the block explicitly instead of treating the HTML challenge as an API response.

## GitHub production environment

- Secret `VPS_DEPLOY_KEY`: a dedicated Ed25519 private key.
- Variable `VPS_HOST`: `89.169.155.195`.
- Variable `VPS_USER`: `wien-deploy`.
- Variable `VPS_SSH_KNOWN_HOSTS`: the pinned server Ed25519 host key line.

The deployment key is separate from the owner's SSH key. Its public key in
`wien-deploy`'s authorized_keys uses `restrict` and a forced deployment command:
interactive shell, forwarding and PTY are unavailable. The receiver only accepts
`check` or `deploy COMMIT-RUN-ATTEMPT`. This key still grants authority to replace
application images and production configuration; keep it only in the production
GitHub environment and the local ignored `.local` directory.

`deploy/receive.sh` is installed root-owned as `/usr/local/sbin/wien-deploy`.
Changes to the receiver itself require an operator to reinstall it over the
owner's SSH connection. **Before the first subscription release**, install the
updated `deploy/receive.sh`: the previous receiver expects assist to return 503
and would roll back a successful authenticated release. The updated receiver
accepts 401 for assist and 404 for the removed generate endpoint, while remaining
compatible with the previous release.

```sh
ssh spacespace01 'sudo install -m 0755 /dev/stdin /usr/local/sbin/wien-deploy' < deploy/receive.sh
```
Ordinary releases only update images and release configs.
The web image uses the existing archive format, so the previous receiver can deploy
it. Reinstall the current receiver to also verify the web HTML after deployment
and clean up old `wien-web` images.

## Operator commands

Inspect without printing secrets:

```sh
ssh spacespace01 'readlink -f /opt/wien/current; sudo docker ps'
```

To inspect the active Compose project on the VPS:

```sh
cd /opt/wien/current
sudo env WIEN_RELEASE_ID="$(basename "$(pwd -P)")" docker compose \
  --project-name wien --env-file /opt/wien/.env -f compose.yaml ps
```

Do not run `docker compose down --volumes`: the RAG corpus must survive releases.

## PostgreSQL and accounts

Before the first release with accounts, run this once as the VPS operator:

```sh
ssh spacespace01 'sudo bash -s' < deploy/init-database.sh
```

This creates the external `wien_users-data` Docker volume and adds a random
URL-safe hex `POSTGRES_PASSWORD` to `/opt/wien/.env` (0600), saving a private backup.
It preserves an existing password and does not restart services.
Keep the password persistent: changing the environment does not rotate an existing
PostgreSQL user's password. PostgreSQL 18 stores its files under `/var/lib/postgresql`
in this volume and has no published host port. The same DB survives image releases
and rollback. Back it up independently of release archives.

The server applies embedded SQLx migrations before accepting requests and fails
startup if the database or migration is unavailable. `/ready` checks PostgreSQL
as well as the RAG corpus. Migrations must remain compatible with the previous
server version because image rollback does not reverse database migrations.

Registration currently has no CAPTCHA. Limits shared through PostgreSQL allow
20 registration attempts globally per 15 minutes and 10 login attempts per username
per 15 minutes, plus 240 expensive auth attempts globally per 15 minutes and two
concurrent password hashing operations per server. These initial limits are for
small-scale use; they do not replace per-client abuse controls for public growth.
