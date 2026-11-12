#!/usr/bin/env bash
# Run once as root on the VPS before releasing the accounts-enabled backend.
# Does not start/restart services or change an existing database password.
set -euo pipefail
umask 077
python3 - <<'PY'
import os
from pathlib import Path
import secrets
import shutil
import time

path = Path('/opt/wien/.env')
source = path.read_text()
existing = [line for line in source.splitlines() if line.startswith('POSTGRES_PASSWORD=')]
if existing:
    if not existing[-1].split('=', 1)[1].strip():
        raise SystemExit('POSTGRES_PASSWORD exists but is empty; configure it explicitly.')
    print('PostgreSQL password already configured; preserving it.')
else:
    backup = path.with_name('.env.before-accounts-' + str(time.time_ns()))
    shutil.copyfile(path, backup)
    os.chmod(backup, 0o600)
    staged = path.with_name('.env.accounts-next')
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write(source.rstrip() + '\n\nPOSTGRES_PASSWORD=' + secrets.token_hex(32) + '\n')
    os.replace(staged, path)
    print('PostgreSQL password configured; private .env backup saved.')
PY
docker volume create wien_users-data
