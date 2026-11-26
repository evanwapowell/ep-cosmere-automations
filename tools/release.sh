#!/usr/bin/env bash
# Release: bump the version in module.json, run the tests, commit, tag, build module.zip and publish a
# GitHub release with module.json and module.zip attached.
#
#   tools/release.sh 0.1.1
#
# Needs: node, git, zip-capable `git archive`, and the GitHub CLI (`gh`) logged in. Run from a clean main branch.
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

repo="evanwapowell/ep-cosmere-automations"
node - "$version" "$repo" <<'EOF'
const fs = require('fs');
const [version, repo] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync('module.json', 'utf8'));
manifest.version = version;
manifest.download = `https://github.com/${repo}/releases/download/v${version}/module.zip`;
fs.writeFileSync('module.json', JSON.stringify(manifest, null, 2) + '\n');
EOF

git add module.json
git commit -m "Release v$version"
git tag "v$version"

out="$(mktemp -d)"
# Files marked export-ignore in .gitattributes (tests, tools, design notes) stay out of the zip.
git archive --format=zip --output="$out/module.zip" "v$version"
cp module.json "$out/module.json"

git push origin HEAD "v$version"
gh release create "v$version" "$out/module.zip" "$out/module.json" --repo "$repo" --title "v$version" --generate-notes
echo "Released v$version"
