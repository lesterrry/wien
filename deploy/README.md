# Backend releases

GitHub → Actions → **Release backend** → **Run workflow** → choose a branch → Run.
Only `workflow_dispatch` deploys; pushes and pull requests do not deploy.
The workflow must first be merged into the repository's default branch for the
button to appear. The chosen branch supplies both source and server configs.

The runner builds `linux/amd64` server and RAG images, tags them with
`commit-run-attempt`, and transfers a release archive over SSH to `89.169.155.195`.
No registry login is needed. The VPS loads the ready images without compiling Rust.
Releases live in `/opt/wien/releases`; `current` and `previous` identify deployments.
A failed local health/readiness check triggers restoration of the previous release.
The receiver retains two successful releases and their images.

Production uses `deploy/compose.yaml`, not `just run-server` or the local Codex
override. `/opt/wien/.env` and external volume `wien_skill-data` remain on the VPS.
AI Tunnel credentials and the RAG corpus are never uploaded to GitHub Actions.
Nginx serves HTTP behind Cloudflare; no certificates are created.
Public `/v1/*` remains disabled until accounts and authentication are implemented.

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
owner's SSH connection. Ordinary releases only update images and release configs.

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
