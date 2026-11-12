#!/usr/bin/env bash
# Installed root-owned as /usr/local/sbin/wien-deploy; called by the restricted CI key.
set -euo pipefail
umask 077
command=${1:-}
root=/opt/wien
if [[ "$command" == check ]]; then
    test -r "$root/.env"
    test -L "$root/current"
    docker info >/dev/null
    printf 'Wien deployment receiver is ready.\n'
    exit 0
fi
if [[ ! "$command" =~ ^deploy\ ([a-f0-9]{40}-[0-9]+-[0-9]+)$ ]]; then
    printf 'Only check or deploy RELEASE_ID is allowed.\n' >&2
    exit 2
fi
release_id=${BASH_REMATCH[1]}
exec 9>"$root/.deploy.lock"
flock -n 9 || { printf 'Another deployment is active.\n' >&2; exit 1; }
previous=$(readlink -f "$root/current")
[[ "$previous" == "$root/releases/"* && -f "$previous/compose.yaml" ]]
release="$root/releases/$release_id"
[[ ! -e "$release" ]] || { printf 'Release already exists.\n' >&2; exit 1; }
staging=$(mktemp -d "$root/releases/.incoming.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
# Accept a bounded archive of ordinary files only; never extract paths, links or devices.
python3 -c '
import os, pathlib, shutil, sys, tarfile
root = pathlib.Path(sys.argv[1])
expected = {"images.tar.gz", "compose.yaml", "server.toml", "skill.toml", "nginx.conf"}
seen = set()
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for member in archive:
        if member.name not in expected or member.name in seen or not member.isfile():
            raise SystemExit("Unexpected release archive entry")
        limit = 1024**3 if member.name == "images.tar.gz" else 1024**2
        if member.size < 0 or member.size > limit:
            raise SystemExit("Release archive entry exceeds size limit")
        with archive.extractfile(member) as source, (root / member.name).open("xb") as target:
            shutil.copyfileobj(source, target)
        os.chmod(root / member.name, 0o644)
        seen.add(member.name)
if seen != expected:
    raise SystemExit("Incomplete release archive")
' "$staging"
gzip -dc "$staging/images.tar.gz" | docker load
rm "$staging/images.tar.gz"
for service in server skill; do
    docker image inspect "wien-$service:$release_id" >/dev/null
done
chmod 755 "$staging"
mv "$staging" "$release"
compose() {
    local directory=$1
    shift
    WIEN_RELEASE_ID=$(basename "$directory") docker compose \
        --project-name wien --env-file "$root/.env" \
        --project-directory "$directory" -f "$directory/compose.yaml" "$@"
}
activate() {
    local directory=$1
    compose "$directory" config --quiet || return 1
    compose "$directory" up -d --no-build --wait --wait-timeout 120 || return 1
    # Nginx must resolve the new server container address after replacement.
    compose "$directory" up -d --no-build --force-recreate proxy || return 1
    curl --fail --silent --show-error --connect-timeout 5 --max-time 10 --retry 10 --retry-delay 2 --retry-all-errors \
        http://127.0.0.1:3001/ready || return 1
    curl --fail --silent --show-error --connect-timeout 5 --max-time 10 --retry 10 --retry-delay 2 --retry-all-errors \
        -H 'Host: wien.aydar.media' http://127.0.0.1/ready || return 1
    # Older releases have no web image and redirect / to API docs.
    if docker image inspect "wien-web:$(basename "$directory")" >/dev/null 2>&1; then
        curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
            -H 'Host: wien.aydar.media' http://127.0.0.1/ \
            | python3 -c 'import sys; html=sys.stdin.read(); sys.exit(0 if "<title>Wien</title>" in html and "/assets/" in html else 1)' || return 1
    fi
    local status
    status=$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null --write-out '%{http_code}' \
        -X POST -H 'Host: wien.aydar.media' http://127.0.0.1/v1/assist) || return 1
    # 503 supports rollback to releases with inference completely disabled.
    [[ "$status" == 401 || "$status" == 503 ]] || return 1
    status=$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null --write-out '%{http_code}' \
        -X POST -H 'Host: wien.aydar.media' http://127.0.0.1/v1/generate) || return 1
    # Removed endpoint returns 404; 503 supports rollback to older nginx configs.
    [[ "$status" == 404 || "$status" == 503 ]]
}
if ! activate "$release"; then
    printf 'Deployment failed; restoring previous release.\n' >&2
    if ! activate "$previous"; then
        printf 'ROLLBACK FAILED; operator intervention required.\n' >&2
    fi
    exit 1
fi
ln -sfn "$previous" "$root/.previous.next"
mv -Tf "$root/.previous.next" "$root/previous"
ln -sfn "$release" "$root/.current.next"
mv -Tf "$root/.current.next" "$root/current"
printf 'Deployed %s\n' "$release_id"
# Keep current and previous releases for rollback, including their image tags.
for old in "$root"/releases/*; do
    [[ -d "$old" && "$old" != "$release" && "$old" != "$previous" ]] || continue
    old_id=$(basename "$old")
    docker image rm "wien-server:$old_id" "wien-skill:$old_id" "wien-web:$old_id" >/dev/null 2>&1 || true
    rm -rf -- "$old"
done
