#!/usr/bin/env bash
# Release: bump the version in module.json, run the tests, commit, tag and push. The "Release" GitHub Actions
# workflow (.github/workflows/release.yml) then builds module.zip and publishes the GitHub release.
#
#   tools/release.sh 0.3.1
#
# Needs: node and git. Run from a clean checkout of the branch you release from.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: tools/release.sh <major.minor.patch>" >&2
    exit 1
fi

cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree is not clean" >&2
    exit 1
fi

node --test

node - "$version" <<'JS'
const fs = require('fs');
const [version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync('module.json', 'utf8'));
manifest.version = version;
manifest.download = manifest.download.replace(/\/v[^/]+\/module\.zip$/, `/v${version}/module.zip`);
fs.writeFileSync('module.json', JSON.stringify(manifest, null, 2) + '\n');
JS

git add module.json
git commit -m "Release v$version"
git tag "v$version"
git push origin HEAD "v$version"
echo "Tagged v$version; the Release workflow publishes it."
