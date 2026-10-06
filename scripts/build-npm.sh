#!/usr/bin/env bash
set -euo pipefail

# build-npm.sh — Build the paperclipai CLI package for npm publishing.
#
# Uses esbuild to bundle all workspace code into a single file,
# keeping external npm dependencies as regular package dependencies.
#
# Usage:
#   ./scripts/build-npm.sh               # full build
#   ./scripts/build-npm.sh --skip-checks  # skip forbidden-token check (CI without token list)

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
DIST_DIR="$CLI_DIR/dist"

skip_checks=false
skip_typecheck=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) skip_checks=true ;;
    --skip-typecheck) skip_typecheck=true ;;
  esac
done

# Managed Git installs build a GitHub source archive, so the checkout has no
# .git directory. New installers pass the resolved SHA directly. For upgrades
# driven by an older installed CLI, recover the same immutable SHA from the
# codeload archive's top-level directory. The archive is authoritative when it
# exists: never let a stale ambient value describe different deployed code.
managed_git_archive="$REPO_ROOT/../source.tar.gz"
if [ -f "$managed_git_archive" ]; then
  PAPERCLIP_BUILD_COMMIT="$(
    bash "$REPO_ROOT/scripts/resolve-managed-git-build-commit.sh" "$managed_git_archive"
  )"
  export PAPERCLIP_BUILD_COMMIT
  printf '%s\n' "$PAPERCLIP_BUILD_COMMIT" > "$REPO_ROOT/.paperclip-build-commit"
fi

if [ -n "${PAPERCLIP_BUILD_COMMIT:-}" ]; then
  node "$REPO_ROOT/server/scripts/write-build-stamp.mjs"
fi

echo "==> Building paperclipai for npm"

# ── Step 1: Forbidden token check ──────────────────────────────────────────────
if [ "$skip_checks" = false ]; then
  echo "  [1/5] Running forbidden token check..."
  node "$REPO_ROOT/scripts/check-forbidden-tokens.mjs"
else
  echo "  [1/5] Skipping forbidden token check (--skip-checks)"
fi

# ── Step 2: TypeScript type-check ──────────────────────────────────────────────
if [ "$skip_typecheck" = false ]; then
  echo "  [2/6] Type-checking..."
  cd "$REPO_ROOT"
  corepack pnpm -r typecheck
else
  echo "  [2/6] Skipping type-check (--skip-typecheck)"
fi

# ── Step 3: Bundle CLI with esbuild ────────────────────────────────────────────
echo "  [3/6] Bundling CLI with esbuild..."
cd "$CLI_DIR"
rm -rf dist

node --input-type=module -e "
import esbuild from 'esbuild';
import config from './esbuild.config.mjs';
await esbuild.build(config);
"

chmod +x dist/index.js

# ── Step 4: Prepare server UI assets ───────────────────────────────────────────
# The managed Git installer executes this bundled script from its currently
# installed CLI. Prepare the fetched checkout's server UI before that installer
# stages bundled workspace packages.
echo "  [4/7] Preparing server UI assets..."
cd "$REPO_ROOT"
PAPERCLIP_RELEASE_REUSE_UI_DIST=1 bash "$REPO_ROOT/scripts/prepare-server-ui-dist.sh"

# ── Step 5: Prepare packaged skills ────────────────────────────────────────────
# Release packaging normally performs this copy in release.sh. Managed Git
# installs execute this fetched checkout script directly, so stage the same files
# before the installed CLI iterates package.json "files" entries.
echo "  [5/8] Preparing packaged skills..."
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done

# ── Step 6: Validate bundled entrypoint syntax ─────────────────────────────────
echo "  [6/8] Verifying bundled entrypoint syntax..."
node --check "$DIST_DIR/index.js"

# ── Step 7: Back up dev package.json, generate publishable one ─────────────────
echo "  [7/8] Generating publishable package.json..."
cp "$CLI_DIR/package.json" "$CLI_DIR/package.dev.json"
node "$REPO_ROOT/scripts/generate-npm-package-json.mjs"

# Copy the root README so npm shows the repo README on the package page, but
# rewrite repository-relative image assets because npm resolves README links
# under the package's `repository.directory` (`cli`), not the repository root.
README_ASSET_REF="${PAPERCLIP_README_ASSET_REF:-}"
if [ -z "$README_ASSET_REF" ]; then
  README_ASSET_REF="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
README_ASSET_REF="${README_ASSET_REF:-master}"
node "$REPO_ROOT/scripts/prepare-npm-readme.mjs" \
  "$REPO_ROOT/README.md" \
  "$CLI_DIR/README.md" \
  "$README_ASSET_REF"

# ── Step 8: Summary ───────────────────────────────────────────────────────────
BUNDLE_SIZE=$(wc -c < "$DIST_DIR/index.js" | xargs)
echo "  [8/8] Build verification..."
echo ""
echo "Build complete."
echo "  Bundle: cli/dist/index.js (${BUNDLE_SIZE} bytes)"
echo "  Source map: cli/dist/index.js.map"
echo ""
echo "To preview:   cd cli && npm pack --dry-run"
echo "To publish:   cd cli && npm publish --access public"
echo "To restore:   mv cli/package.dev.json cli/package.json"
