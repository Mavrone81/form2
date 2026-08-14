#!/usr/bin/env bash
# Fails if any form content is tracked by git. The source forms and completed
# records are commercially sensitive and must never enter the repository.
#
# Also sweeps mobile/ for tracked signing material (the release keystore must
# come from the ANDROID_KEYSTORE_B64 GitHub secret, decoded at CI time --
# see .github/workflows/android.yml -- never from a file in the repo).
set -euo pipefail

PATTERNS='\.(xlsx|xls|pdf)$|^Sample of Forms/|^PM Document 2026/|^test/fixtures\.local\.json$|\.sqlite$|\.db$|^data/'

tracked=$(git ls-files | grep -E "$PATTERNS" || true)

# Keystores anywhere under mobile/ (the app's android/ dir, or anywhere else
# someone might drop one), matched independently of the form-content
# patterns above since the reason they're forbidden is different (secret
# material, not commercial sensitivity).
keystores=$(git ls-files mobile | grep -E '\.(keystore|jks)$' || true)

if [ -n "$tracked" ] || [ -n "$keystores" ]; then
  if [ -n "$tracked" ]; then
    echo "Sensitive files are tracked by git:"
    echo "$tracked" | sed 's/^/  /'
    echo
  fi
  if [ -n "$keystores" ]; then
    echo "Signing keystores are tracked by git:"
    echo "$keystores" | sed 's/^/  /'
    echo
  fi
  echo "These must never be committed. Remove them with:"
  echo "  git rm --cached <file>"
  echo "and confirm .gitignore covers them."
  exit 1
fi

echo "No sensitive files tracked."
