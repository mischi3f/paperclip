#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:?Usage: resolve-managed-git-build-commit.sh <source.tar.gz>}"
archive_root="$({ tar -tzf "$archive_path" | {
  IFS= read -r first_entry
  printf '%s\n' "$first_entry"
  cat >/dev/null
}; })"

if [[ ! "$archive_root" =~ ^[^/]+-([0-9a-fA-F]{40})/$ ]]; then
  echo "Managed Git archive has no full commit SHA in its top-level directory: $archive_root" >&2
  exit 1
fi

printf '%s\n' "${BASH_REMATCH[1],,}"
