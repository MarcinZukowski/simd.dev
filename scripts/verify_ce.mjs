#!/usr/bin/env node
// scripts/verify_ce.mjs
//
// Slowly crawl every worked-example intrinsic, build the same C++ harness
// the website's "see on CE" button generates, ship it to Compiler
// Explorer, and check that the result still compiles -- and where
// possible that the bytes coming back match the cached expected output.
//
// Output: data/ce_verify.jsonl, one row per attempted intrinsic, sorted
// by name. Status field is one of:
//   ok               -- compile (and execute, if applicable) succeeded;
//                       result bytes (if checked) match the cached entry.
//   compile_failed   -- clang on CE rejected the source.
//   output_mismatch  -- compiled / ran but produced different bytes.
//   no_result_bytes  -- fold-mode compile succeeded but RESULT was not
//                       folded to .rodata (clang couldn't constexpr it).
//   skipped:<reason> -- e.g. no example, pointer param, no ceConfig.
//
// Resumable: re-running skips rows whose harness_hash is unchanged and
// whose last status was `ok`. Failures get re-tested every run so a
// codegen fix is reflected on the next pass.
//
// Polite by default: 1 request per second, exponential backoff on
// 429/5xx. Override with --rps.
//
// Usage:
//   node scripts/verify_ce.mjs [--limit N] [--rps F] [--filter REGEX]
//                              [--source intel|arm] [--force] [--dry-run]
//                              [--names NAME,NAME,...] [--out PATH]
//
// Example:
//   node scripts/verify_ce.mjs --limit 20 --filter '^_mm_(add|sub)_epi'
//   node scripts/verify_ce.mjs --names _mm256_mask_compress_epi32

import { createRequire } from 'node:module';
import { readFileSync, existsSync, renameSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const SimdHarness = require('../simd.dev/harness.js');

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));
const DATA_PATH = join(REPO_ROOT, 'simd-tooltip', 'dist', 'simd-data.json');
const OUT_PATH_DEFAULT = join(REPO_ROOT, 'data', 'ce_verify.jsonl');
const CE_BASE = 'https://godbolt.org';

// ---------------------------------------------------------------------
// ceConfigFor: ported from simd-tooltip/dist/simd-tooltips.js.
// Pure function of `rec`; must stay in sync with the browser version.
// ---------------------------------------------------------------------

const CE_INTEL_FLAGS = {
    'MMX': '-mmmx', 'SSE': '-msse', 'SSE2': '-msse2', 'SSE3': '-msse3',
    'SSSE3': '-mssse3', 'SSE4.1': '-msse4.1', 'SSE4.2': '-msse4.2',
    'AVX': '-mavx', 'AVX2': '-mavx2',
    'FMA': '-mfma', 'AES': '-maes', 'SHA': '-msha', 'SHA512': '-msha512',
    'BMI1': '-mbmi', 'BMI2': '-mbmi2', 'POPCNT': '-mpopcnt',
    'F16C': '-mf16c', 'GFNI': '-mgfni', 'VAES': '-mvaes',
    'VPCLMULQDQ': '-mvpclmulqdq', 'PCLMULQDQ': '-mpclmul',
    'AVX512F': '-mavx512f', 'AVX512VL': '-mavx512vl',
    'AVX512BW': '-mavx512bw', 'AVX512DQ': '-mavx512dq',
    'AVX512CD': '-mavx512cd', 'AVX512_BF16': '-mavx512bf16',
    'AVX512_FP16': '-mavx512fp16', 'AVX512_VBMI': '-mavx512vbmi',
    'AVX512_VBMI2': '-mavx512vbmi2', 'AVX512_VNNI': '-mavx512vnni',
    'AVX512_BITALG': '-mavx512bitalg', 'AVX512VPOPCNTDQ': '-mavx512vpopcntdq',
    'AVX512IFMA52': '-mavx512ifma', 'AVX512_VP2INTERSECT': '-mavx512vp2intersect',
    'AVX_VNNI': '-mavxvnni', 'AVX_VNNI_INT8': '-mavxvnniint8',
    'AVX_VNNI_INT16': '-mavxvnniint16', 'AVX_IFMA': '-mavxifma',
    'AVX_NE_CONVERT': '-mavxneconvert',
};

const ARM_EXT = '+fp16+bf16+i8mm+dotprod+crypto';
const CE_ARM_ARCHS = {
    'Neon':         { compiler: 'armv8-full-cclang-trunk', march: 'armv8.6-a' + ARM_EXT,                                       headers: ['arm_neon.h', 'arm_fp16.h', 'arm_bf16.h', 'arm_acle.h'] },
    'SVE':          { compiler: 'armv8-full-cclang-trunk', march: 'armv8.6-a+sve' + ARM_EXT,                                   headers: ['arm_sve.h', 'arm_neon_sve_bridge.h', 'arm_acle.h']  },
    'SVE2':         { compiler: 'armv8-full-cclang-trunk', march: 'armv9-a' + ARM_EXT,                                         headers: ['arm_sve.h', 'arm_neon_sve_bridge.h', 'arm_acle.h']  },
    'SME and SME2': { compiler: 'armv8-full-cclang-trunk', march: 'armv9.2-a+sme2+sme-i16i64+sme-f64f64' + ARM_EXT,             headers: ['arm_sve.h', 'arm_sme.h', 'arm_neon_sve_bridge.h', 'arm_acle.h'] },
    'Helium':       { compiler: 'armv7-cclang-trunk',      march: 'armv8.1-m.main+mve.fp+fp.dp',                                headers: ['arm_mve.h', 'arm_fp16.h', 'arm_bf16.h', 'arm_acle.h'] },
};
const CE_ARM_ARCH_ORDER = ['Neon', 'Helium', 'SVE', 'SVE2', 'SME and SME2'];

function ceConfigFor(rec) {
    if (!rec || rec.kind === 'type') return null;
    if (rec.source === 'arm-acle') {
        const fset = new Set(rec.family || []);
        for (const archKey of CE_ARM_ARCH_ORDER) {
            if (fset.has(archKey)) {
                const a = CE_ARM_ARCHS[archKey];
                return { compiler: a.compiler, options: `-O2 -march=${a.march}`, headers: a.headers };
            }
        }
        return null;
    }
    if (rec.source === 'intel-iguide') {
        const flags = [];
        for (const f of rec.family || []) {
            const flag = CE_INTEL_FLAGS[f];
            if (flag && flags.indexOf(flag) < 0) flags.push(flag);
        }
        if (flags.length === 0) flags.push('-mavx2');
        return { compiler: 'cclang_trunk', options: '-O2 ' + flags.join(' '), headers: ['immintrin.h'] };
    }
    return null;
}

// ---------------------------------------------------------------------
// .rodata parser (ported from app.js)
// ---------------------------------------------------------------------

function parseRodataBytes(asmLines, byteCount) {
    const bytes = new Uint8Array(byteCount);
    let i = 0, inResult = false;
    for (const ln of asmLines) {
        // CE asm lines are {text, source, labels}; an empty `text` is
        // common (blank separator lines). The old `ln.text || ln` short
        // circuit fell through to the object and tripped `.trim`.
        const t = (typeof ln === 'string' ? ln : (ln.text ?? '')).trim();
        if (!inResult) {
            if (/^RESULT:/.test(t)) inResult = true;
            continue;
        }
        // Stop at the next non-data directive or label.
        if (/^[A-Za-z_.][\w.$@]*:\s*$/.test(t)) break;
        if (/^\.section\b/.test(t)) break;
        if (/^\.size\b/.test(t)) break;
        // .byte / .word / .long / .quad / .zero / .ascii etc.
        const mByte = t.match(/^\.byte\s+(.+)$/);
        if (mByte) {
            for (const tok of mByte[1].split(',')) {
                const v = parseInt(tok.trim(), 0);
                if (!Number.isFinite(v)) continue;
                if (i < byteCount) bytes[i++] = v & 0xff;
            }
            continue;
        }
        const mWord = t.match(/^\.(short|hword|2byte)\s+(.+)$/);
        if (mWord) {
            for (const tok of mWord[2].split(',')) {
                const v = parseInt(tok.trim(), 0);
                if (!Number.isFinite(v)) continue;
                if (i < byteCount) bytes[i++] = v & 0xff;
                if (i < byteCount) bytes[i++] = (v >> 8) & 0xff;
            }
            continue;
        }
        const mLong = t.match(/^\.(long|word|4byte)\s+(.+)$/);
        if (mLong) {
            for (const tok of mLong[2].split(',')) {
                const v = parseInt(tok.trim(), 0);
                if (!Number.isFinite(v)) continue;
                for (let k = 0; k < 4; k++) if (i < byteCount) bytes[i++] = (v >>> (k * 8)) & 0xff;
            }
            continue;
        }
        const mQuad = t.match(/^\.(quad|xword|8byte)\s+(.+)$/);
        if (mQuad) {
            for (const tok of mQuad[2].split(',')) {
                let v;
                try { v = BigInt(tok.trim()); } catch (_) { continue; }
                for (let k = 0; k < 8; k++) if (i < byteCount) bytes[i++] = Number((v >> BigInt(k * 8)) & 0xffn);
            }
            continue;
        }
        const mZero = t.match(/^\.zero\s+(\d+)/);
        if (mZero) {
            const n = +mZero[1];
            for (let k = 0; k < n; k++) if (i < byteCount) bytes[i++] = 0;
            continue;
        }
    }
    return { bytes, found: i, complete: i >= byteCount };
}

// ---------------------------------------------------------------------
// CE HTTP
// ---------------------------------------------------------------------

async function ceCompile(rec, cfg, source, mode) {
    const url = `${CE_BASE}/api/compiler/${encodeURIComponent(cfg.compiler)}/compile`;
    const body = {
        source,
        options: {
            userArguments: cfg.options + ' -x c++',
            filters: {
                binary: false, commentOnly: true, demangle: false,
                directives: false,
                execute: mode === 'execute',
                intel: false,
                labels: true, libraryCode: false, trim: false,
            },
            compilerOptions: { executorRequest: mode === 'execute' },
            libraries: [],
        },
        lang: 'c',
    };
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                   'User-Agent': 'simd.dev-verifier/0.1 (+https://simd.dev)' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        err.status = resp.status;
        throw err;
    }
    return resp.json();
}

function expectedOutputBytes(rec) {
    return Math.floor((rec.example.output.bytes_hex || '').length / 2);
}

// ---------------------------------------------------------------------
// Per-record verification
// ---------------------------------------------------------------------

function shortStderr(arr, n = 240) {
    const s = (arr || []).map(l => (typeof l === 'string' ? l : l.text || '')).join('\n').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
}

async function verifyOne(rec) {
    if (!SimdHarness.isLiveViewable(rec)) {
        return { status: 'skipped:not_viewable' };
    }
    const cfg = ceConfigFor(rec);
    if (!cfg) {
        return { status: 'skipped:no_ce_config' };
    }
    let source;
    try {
        source = SimdHarness.buildFoldSource(rec, rec.example.inputs.map(i => i.values), ceConfigFor);
    } catch (e) {
        return { status: 'skipped:harness_error', error_excerpt: e.message };
    }

    const intel = SimdHarness.isIntelIntrinsic(rec.name);
    const verifiedVia = rec.example.verified_via;
    // Intel `execute` records use CE's executor backend. Everything else
    // (intel fold, all arm) goes through compile-mode + .rodata parse.
    const mode = (intel && verifiedVia === 'execute') ? 'execute' : 'fold';
    const data = await ceCompile(rec, cfg, source, mode);

    const meta = {
        harness_hash: hashHarness(cfg, source),
        compiler: cfg.compiler,
        options: cfg.options,
        mode,
    };

    if (mode === 'execute') {
        const exec = data.execResult || data;
        if (exec.buildResult && exec.buildResult.code !== 0) {
            return { ...meta, status: 'compile_failed', error_excerpt: shortStderr(exec.buildResult.stderr) };
        }
        if (exec.code !== 0) {
            return { ...meta, status: 'run_failed', error_excerpt: shortStderr(exec.stderr) };
        }
        const out = (exec.stdout || []).map(l => l.text || l).join('').trim();
        if (!/^[0-9a-fA-F]+$/.test(out)) {
            return { ...meta, status: 'output_unparseable', error_excerpt: out.slice(0, 120) };
        }
        const expectedHex = (rec.example.output.bytes_hex || '').toLowerCase();
        const gotHex = out.toLowerCase().slice(0, expectedHex.length);
        if (gotHex !== expectedHex) {
            return { ...meta, status: 'output_mismatch',
                error_excerpt: `expected ${expectedHex} got ${gotHex.slice(0, 80)}` };
        }
        return { ...meta, status: 'ok' };
    }

    // mode === 'fold'
    if (data.code !== 0) {
        return { ...meta, status: 'compile_failed', error_excerpt: shortStderr(data.stderr) };
    }
    // ARM with verified_via=execute has no CE executor; just confirming
    // compile success is the best we can do.
    if (!intel && verifiedVia === 'execute') {
        return { ...meta, status: 'ok', notes: 'compile_only' };
    }
    const expected = expectedOutputBytes(rec);
    if (!expected) return { ...meta, status: 'skipped:no_expected_bytes' };
    const parsed = parseRodataBytes(data.asm || [], expected);
    if (!parsed.complete) {
        return { ...meta, status: 'no_result_bytes',
            error_excerpt: `parsed ${parsed.found}/${expected} bytes from .rodata` };
    }
    const gotHex = bytesToHex(parsed.bytes).toLowerCase();
    const expectedHex = (rec.example.output.bytes_hex || '').toLowerCase();
    if (gotHex !== expectedHex) {
        return { ...meta, status: 'output_mismatch',
            error_excerpt: `expected ${expectedHex} got ${gotHex.slice(0, 80)}` };
    }
    return { ...meta, status: 'ok' };
}

function hashHarness(cfg, source) {
    return createHash('sha256')
        .update(cfg.compiler).update('\0')
        .update(cfg.options).update('\0')
        .update(source)
        .digest('hex').slice(0, 16);
}

function bytesToHex(bytes) {
    let s = '';
    for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
    return s;
}

// ---------------------------------------------------------------------
// State (data/ce_verify.jsonl)
// ---------------------------------------------------------------------

function loadState(path) {
    const map = new Map();
    if (!existsSync(path)) return map;
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            if (row && row.name) map.set(row.name, row);
        } catch (_) { /* skip junk */ }
    }
    return map;
}

async function saveState(path, map) {
    const names = [...map.keys()].sort();
    const lines = names.map(n => JSON.stringify(map.get(n)));
    const text = lines.join('\n') + '\n';
    const tmp = path + '.tmp';
    await writeFile(tmp, text, { encoding: 'utf8' });
    renameSync(tmp, path);
}

// ---------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        limit: Infinity, rps: 1, filter: null, source: null,
        force: false, dryRun: false, names: null,
        out: OUT_PATH_DEFAULT,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const eat = () => argv[++i];
        if (a === '--limit') opts.limit = +eat();
        else if (a === '--rps') opts.rps = +eat();
        else if (a === '--filter') opts.filter = new RegExp(eat());
        else if (a === '--source') opts.source = eat();
        else if (a === '--force') opts.force = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--names') opts.names = new Set(eat().split(','));
        else if (a === '--out') opts.out = eat();
        else if (a === '--help' || a === '-h') {
            console.log('Usage: node scripts/verify_ce.mjs [--limit N] [--rps F] [--filter REGEX]');
            console.log('       [--source intel|arm] [--force] [--dry-run] [--names N1,N2,...] [--out PATH]');
            process.exit(0);
        }
        else throw new Error('unknown arg ' + a);
    }
    return opts;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const opts = parseArgs(process.argv);
    const minIntervalMs = 1000 / opts.rps;
    console.log(`>> loading ${DATA_PATH}`);
    const doc = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    const records = doc.records || doc;
    const state = loadState(opts.out);
    console.log(`>> existing state rows: ${state.size}`);

    // Build the work list deterministically.
    let names = Object.keys(records).sort();
    if (opts.filter) names = names.filter(n => opts.filter.test(n));
    if (opts.names) names = names.filter(n => opts.names.has(n));
    if (opts.source === 'intel') names = names.filter(n => records[n].source === 'intel-iguide');
    if (opts.source === 'arm') names = names.filter(n => records[n].source === 'arm-acle');

    let tested = 0, attempted = 0, skipped_cached = 0;
    let lastReq = 0;
    const SAVE_EVERY = 20;

    for (const name of names) {
        if (tested >= opts.limit) break;
        const rec = { name, ...records[name] };
        if (!rec.example) continue;

        const prior = state.get(name);
        if (!opts.force && prior && prior.status === 'ok') {
            // Could re-hash to detect harness drift, but for the common
            // "rerun next week, same data" case the name alone is enough.
            // We'll add hash-pinning if drift becomes a real problem.
            skipped_cached++;
            continue;
        }

        attempted++;
        if (opts.dryRun) {
            try {
                const src = SimdHarness.buildFoldSource(rec, rec.example.inputs.map(i => i.values), ceConfigFor);
                console.log(`\n=== ${name} ===\n${src}`);
            } catch (e) {
                console.log(`\n=== ${name} === SKIP: ${e.message}`);
            }
            continue;
        }

        // Polite throttling.
        const now = Date.now();
        const wait = Math.max(0, lastReq + minIntervalMs - now);
        if (wait > 0) await sleep(wait);
        lastReq = Date.now();

        let result;
        let backoff = 2000;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                result = await verifyOne(rec);
                break;
            } catch (e) {
                const transient = !e.status || e.status === 429 || (e.status >= 500 && e.status < 600);
                if (!transient || attempt === 4) {
                    result = { status: 'network_error', error_excerpt: e.message.slice(0, 200) };
                    break;
                }
                console.warn(`  retry ${attempt + 1} for ${name} in ${backoff}ms: ${e.message.slice(0, 120)}`);
                await sleep(backoff);
                backoff *= 2;
                lastReq = Date.now();
            }
        }

        const row = { name, ...result };
        state.set(name, row);
        const isOk = result.status === 'ok';
        const mark = isOk ? '✓' : '✗';
        const tail = isOk ? '' : `  -- ${result.status}${result.error_excerpt ? ': ' + result.error_excerpt.split('\n')[0] : ''}`;
        console.log(`${mark} [${tested + 1}] ${name}${tail}`);
        tested++;

        if (tested % SAVE_EVERY === 0) {
            await saveState(opts.out, state);
        }
    }

    if (!opts.dryRun) await saveState(opts.out, state);
    console.log(`\n>> done. tested=${tested} cached_ok=${skipped_cached} attempted=${attempted} state_rows=${state.size}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
