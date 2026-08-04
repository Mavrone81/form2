#!/usr/bin/env bash
# Fails if any form content is tracked by git. The source forms and completed
# records are commercially sensitive and must never enter the repository.
set -euo pipefail

PATTERNS='\.(xlsx|xls|pdf)$|^Sample of Forms/|^PM Document 2026/|^test/fixtures\.local\.json$|\.sqlite$|\.db$|^data/'

tracked=$(git ls-files | grep -E "$PATTERNS" || true)

if [ -n "$tracked" ]; then
  echo "Sensitive files are tracked by git:"
  echo "$tracked" | sed 's/^/  /'
  echo
  echo "These must never be committed. Remove them with:"
  echo "  git rm --cached <file>"
  echo "and confirm .gitignore covers them."
  exit 1
fi

echo "No sensitive files tracked."
