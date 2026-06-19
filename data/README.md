# SIMD intrinsic database

A unified, normalized catalog of SIMD intrinsics for the major
architectures, built from upstream vendor and compiler sources.

## Files

| File             | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `intrinsics.jsonl` | One JSON record per line. The database itself.                       |
| `stats.json`     | Summary counts (by source, by arch, by SIMD family, by desc source).   |
| `ce_verify.jsonl`  | Per-intrinsic Compiler Explorer round-trip status. Populated incrementally by `scripts/verify_ce.mjs`. |
| `NOTICE`         | Required attributions for upstream sources (CC-BY-SA, Apache, Intel).  |

Current size: ~7.7 MB (`wc -l intrinsics.jsonl` → 21,484 records).

## Coverage

| Arch       | Families                                | Records |
| ---------- | --------------------------------------- | ------: |
| `aarch64`  | NEON, SVE, SVE2, "SME and SME2"         |  11,867 |
| `aarch32`  | NEON (v7/A32)                           |   2,754 |
| `armv8m`   | Helium / MVE                            |   2,471 |
| `x86_64`   | MMX, SSE…SSE4.2, AVX/AVX2, AVX-512 (F/VL/BW/DQ/CD/BF16/FP16/VBMI/VBMI2/VNNI/IFMA52/POPCNTDQ/BITALG/VP2INTERSECT), AVX10, AMX, AES, SHA, FMA, BMI1/2, GFNI, VAES, VPCLMULQDQ, etc. |   7,146 |

Notes:

- ARM ACLE tags every SVE intrinsic as also available in SME context, so
  the family bucket "SME and SME2" overlaps SVE — it's not 6,380 distinct
  SME-only intrinsics.
- Intel `arch` is coarse: every entry is tagged `x86_64` even though many
  also work on 32-bit x86. Refining this requires inspecting parameter
  types (intrinsics taking `__int64` are 64-bit-only).

## Record schema

```jsonc
{
  "intrinsic":   "svadd_s32_z",                        // canonical C name
  "aliases":     ["svadd_z"],                          // other callable names
  "arch":        ["aarch64"],                          // target architectures
  "family":      ["SME and SME2", "SVE"],              // SIMD family/version tags
  "definition":  "svint32_t svadd_s32_z(\n    svbool_t pg,\n    svint32_t op1,\n    svint32_t op2)",
  "description": "Add",                                // short prose headline
  "desc_source": "arm-acle",                           // arm-acle | llvm | intel-iguide | synth | ""
  "source":      "arm-acle"                            // arm-acle | intel-iguide
}
```

| Field          | Type        | Notes |
| -------------- | ----------- | ----- |
| `intrinsic`    | string      | The unambiguous, always-callable name.  ARM ACLE encodes overload variance with bracketed segments (`svadd[_s32]_z`); we keep the bracket *contents* for the canonical form, and put the bracket-stripped overloaded form in `aliases`. |
| `aliases`      | list[str]   | Other names the same intrinsic responds to (ACLE overloaded short forms; `__arm_`-prefixed Helium variants). |
| `arch`         | list[str]   | One or more of: `aarch32`, `aarch64`, `armv8m`, `x86_64`. ARM source maps `A64→aarch64`, `A32`/`v7→aarch32`, `MVE→armv8m`. |
| `family`       | list[str]   | SIMD family/version tags. ARM uses ACLE values (`Neon`, `Helium`, `SVE`, `SVE2`, `SME and SME2`). Intel uses CPUID flags (`SSE2`, `AVX2`, `AVX512F`, `AVX512VL`, `AES`, `SHA`, `FMA`, `BMI1`, ...). |
| `definition`   | string      | C signature reconstructed from the upstream record. Multi-arg signatures are pretty-printed onto multiple lines. |
| `description`  | string      | Short prose headline (≤ 280 chars, capped at the first sentence when possible). May be empty for 23 ARM entries whose upstream description is empty. |
| `desc_source`  | string      | Provenance of `description`. See "Description sources" below. |
| `source`       | string      | Provenance of the row itself: `arm-acle` or `intel-iguide`. |

### Duplicate names

20 Intel intrinsics appear twice — these are real upstream duplicates
where the same name exists under both an AVX-512 CPUID flag and a newer
narrow-ISA flag (e.g. `_mm256_madd52lo_epu64` is listed under both
`AVX512IFMA52`+`AVX512VL` and the standalone `AVX_IFMA`). Both records
are kept; their `family` differs.

## Sources

| Source             | License                                | Used for                                                                                  |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| ARM ACLE JSON      | CC-BY-SA-4.0 + patent grant            | ARM rows (everything except descriptions of `desc_source`-tagged rows from other sources) |
| Intel Intrinsics Guide XML | Intel proprietary (no open license) | Intel rows: factual fields (name, signature, CPUID, category, instruction) + first-sentence description |
| LLVM clang headers | Apache-2.0 WITH LLVM-exception         | First-paragraph Doxygen description for ~15% of Intel intrinsics (mostly pre-AVX-512)     |

Upstream URLs:

- ARM: <https://developer.arm.com/architectures/instruction-sets/intrinsics/data/intrinsics.json>
- Intel: <https://www.intel.com/content/dam/develop/public/us/en/include/intrinsics-guide/data-latest.xml>
- LLVM: `https://github.com/llvm/llvm-project/tree/main/clang/lib/Headers`

The cached raw upstream files live in `cache/` (gitignored if/when this
becomes a git repo).

### Description sources

Lookup priority for `description`:

| Priority | `desc_source`    | Coverage      | License |
| :------: | ---------------- | ------------: | ------- |
| 1 (ARM)  | `arm-acle`       | 14,315 / 14,338 | CC-BY-SA-4.0 |
| 1 (Intel)| `llvm`           | 996 / 7,146   | Apache-2.0 WITH LLVM-exception |
| 2 (Intel)| `intel-iguide`   | 6,150 / 7,146 | Intel proprietary (first sentence kept; attribute Intel) |
| 3 (Intel)| `synth`          | 0 / 7,146 today | uncopyrightable: `[Category] compiles to <INSN>.` |
| —        | `""` (empty)     | 23 / 14,338   | upstream had no description |

The synthetic fallback (`synth`) exists in the code path for Intel
entries with neither LLVM coverage nor an XML description, but the
current Intel XML populates `<description>` for every entry, so it isn't
hit in practice.

If you want to remove the Intel-XML descriptions to keep the database
fully under open licenses, edit `scripts/build_db.py` and disable the
`xml_desc` branch in `intel_records()` — those entries fall back to
`synth`.

## Build

End-to-end rebuild from upstream:

```sh
scripts/build_all.sh             # cached re-run, fast (~seconds)
scripts/build_all.sh --refresh   # nuke cache/, fetch everything fresh
```

Dependencies: `python3` (stdlib only — no pip install). `bash` is only
needed for `build_all.sh`; the individual steps are all Python.

The pipeline is four steps; `build_all.sh` runs them in order:

1. `scripts/fetch.py`              — downloads ARM JSON + Intel XML to `cache/`.
2. `scripts/fetch_llvm_descs.py`   — downloads ~130 clang x86 headers to `cache/llvm_headers/` (filtered by name regex; allowlist is in the script).
3. `scripts/extract_llvm_descs.py` — parses Doxygen blocks, writes `cache/llvm_descriptions.json`.
4. `scripts/build_db.py`           — joins everything, writes `data/intrinsics.jsonl` and `data/stats.json`.

Each step is idempotent. Caching: fetch scripts skip files already on
disk; `build_db.py` always re-derives from cache.

### Compiler Explorer verification (`ce_verify.jsonl`)

`scripts/verify_ce.mjs` slowly crawls every viewable intrinsic, builds
the same C++ harness the website's "see on CE" button generates, ships
it to Compiler Explorer, and records the result. The output (one row
per intrinsic, sorted by name) is what the site reads to render the
✓/⚠ badge on the intrinsic page.

Runs out of band — *not* part of `build_all.sh`. Hours, not seconds.

```sh
# typical: full sweep at the default 1 req/sec, resumable
node scripts/verify_ce.mjs

# subset for a quick check / debugging
node scripts/verify_ce.mjs --names _mm_add_epi32,vaddq_s8
node scripts/verify_ce.mjs --filter '^_mm256_mask_' --limit 20

# faster (CE is OK with this on a small/medium sweep; back off if 429s)
node scripts/verify_ce.mjs --rps 2

# dry-run -- print harness sources without hitting CE
node scripts/verify_ce.mjs --names _mm_add_epi32 --dry-run

# ignore the green-status cache, re-test everything
node scripts/verify_ce.mjs --force
```

After a run, sync to the site:

```sh
simd.dev/sync.sh           # copies data/ce_verify.jsonl -> simd.dev/dist/
```

Status values: `ok`, `compile_failed`, `run_failed`, `output_mismatch`,
`output_unparseable`, `no_result_bytes`, `network_error`, `skipped:*`.
The verifier shares the harness module (`simd.dev/harness.js`) with the
browser, so a verifier green tick means the same C++ the user's "see on
CE" button would post.

Dependencies: a Node ≥18 (for global `fetch`). No npm packages.

### Maintenance gotcha

The LLVM header allowlist in `scripts/fetch_llvm_descs.py` is hand-curated
(regex `KEEP`). When LLVM ships a brand-new `*intrin.h` in a future AVX10.x
extension, that header won't be picked up until the regex is extended. ARM
and Intel sources auto-update without code changes.

## Spot-checks

```sh
# Count, sources, families:
cat data/stats.json | python3 -m json.tool | head -25

# Look up one intrinsic:
grep -F '"_mm512_mask_add_pd"' data/intrinsics.jsonl | python3 -m json.tool

# Or load the whole DB into a dict by name:
python3 -c '
import json
db = {r["intrinsic"]: r for r in (json.loads(l) for l in open("data/intrinsics.jsonl"))}
print(db["vfmaq_f32"]["description"])
'
```
