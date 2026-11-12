#!/usr/bin/env python3
"""Check shared infrastructure invariants without external dependencies."""
import json
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
channel = re.search(r'channel = "([^"]+)"', (root / 'rust-toolchain.toml').read_text())[1]
assert f'FROM rust:{channel}-bookworm AS build' in (root / 'Dockerfile').read_text(), 'Docker Rust version differs from toolchain'
metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--locked', '--no-deps', '--format-version', '1'], cwd=root))
assert metadata['workspace_root'] == str(root)
for package in metadata['packages']:
    assert package['edition'] == '2024'
    assert package['rust_version'] == channel
    assert package['publish'] == []
    manifest = pathlib.Path(package['manifest_path']).read_text()
    assert not re.search(r'^(?:version|edition|rust-version|publish) =', manifest, re.M), package['name']
    dependencies = manifest.split('[dependencies]', 1)[1]
    assert all('workspace' in line for line in dependencies.splitlines() if '=' in line), package['name']
assert not (root / 'server/Cargo.lock').exists()
assert not (root / 'skill/Cargo.lock').exists()
assert not (root / 'skill/Cargo.toml').exists()
print('Workspace, toolchain and dependency inheritance are consistent.')
