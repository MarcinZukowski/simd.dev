#!/usr/bin/env bash
# End-to-end rebuild of data/intrinsics.jsonl from upstream sources.
#
# Idempotent: cached files are reused. Pass --refresh to force re-fetch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

# Pick a Python 3.10+ interpreter. We need 3.10 because:
# - build_db.py / extract_llvm_descs.py use PEP 585 generics at runtime
#   without `from __future__ import annotations`.
# - The build scripts call `Path.write_text(..., newline="\n")` to keep
#   committed JSON / JSONL line-ending-stable across Windows; the
#   `newline` kwarg on `write_text` was added in 3.10.
# Try `python3` first (Unix convention), then `python` (Windows / some
# minimal envs).
MIN_MAJOR=3
MIN_MINOR=10
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c "import sys; sys.exit(0 if sys.version_info >= ($MIN_MAJOR, $MIN_MINOR) else 1)" >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  fi
done
if [[ -z "$PY" ]]; then
  echo "error: need Python ${MIN_MAJOR}.${MIN_MINOR}+ on PATH (tried python3, python)." >&2
  echo "       installed versions:" >&2
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "         $candidate -> $("$candidate" --version 2>&1)" >&2
    fi
  done
  exit 1
fi
echo ">> using $PY ($("$PY" --version 2>&1))"

# Force UTF-8 I/O across the pipeline. On non-UTF-8 Windows locales
# (cp1250, cp1252, cp932, ...) Python's default file encoding can't
# represent characters that appear in upstream JSON, like the U+221E
# infinity sign in ARM ACLE pseudocode. The individual scripts pass
# encoding="utf-8" explicitly, but PYTHONUTF8=1 covers any text I/O
# we might add later -- and any subprocess that inherits the env.
export PYTHONUTF8=1

if [[ "${1:-}" == "--refresh" ]]; then
  echo ">> --refresh: clearing cache/"
  rm -rf cache/
fi

echo ">> [1/6] fetching ARM + Intel upstream data ..."
"$PY" scripts/fetch.py

echo ">> [2/6] fetching LLVM clang x86 headers ..."
"$PY" scripts/fetch_llvm_descs.py

echo ">> [3/6] extracting Doxygen descriptions from LLVM headers ..."
"$PY" scripts/extract_llvm_descs.py

echo ">> [4/7] building unified DB ..."
"$PY" scripts/build_db.py

echo ">> [5/7] building web artifacts (simd-tooltip/dist/) ..."
"$PY" scripts/build_web.py

echo ">> [6/7] building ARM per-microarch perf table via llvm-mca ..."
"$PY" scripts/build_arm_perf.py

echo ">> [7/7] syncing dist artifacts into downstream consumers ..."
# Each consumer keeps its own gitignored vendored copy (vsce / static
# hosts / browser extensions can't reliably resolve git symlinks across
# platforms). Re-running the syncs here keeps the four locations from
# drifting -- which is what bit us with simd-vscode going a month stale.
for sync in simd.dev/sync.sh simd-vscode/sync.sh simd-browser-extension/sync.sh; do
    if [[ -x "$sync" ]]; then
        echo ">>   $sync"
        "$sync"
    fi
done

echo
echo ">> done. outputs in data/ and simd-tooltip/dist/ (synced into simd.dev/, simd-vscode/, simd-browser-extension/)."
