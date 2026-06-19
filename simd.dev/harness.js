// simd.dev/harness.js
//
// Type analysis + C++ harness emitter for the "see on CE" / "update via
// CE" flow. Lives in its own file so the same logic can drive both the
// browser-side app.js and a node-side verifier (scripts/verify_ce.*),
// avoiding the "JS bug ships green because the Python verifier reimplemented
// the harness" trap.
//
// UMD wrapper: in the browser this assigns to `globalThis.SimdHarness`;
// in node `require('./harness.js')` returns the module object.
//
// Pure logic. Reads `window.SimdTooltips.ceConfigFor(rec)` for compiler/
// header config inside buildFoldSource; the node caller must inject an
// equivalent shim before invoking that function.

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SimdHarness = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function laneInfo(typeName) {
        if (!typeName) return { bits: null, kind: null };
        if (/^const\s+(?:unsigned\s+)?int$/.test(typeName)) return { bits: 32, kind: 'int' };
        let m = typeName.match(/^(u?)int(8|16|32|64|128)(?:x\d+)*_t$/);
        if (m) return { bits: +m[2], kind: m[1] ? 'uint' : 'int' };
        m = typeName.match(/^poly(8|16|32|64|128)(?:x\d+)*_t$/);
        if (m) return { bits: +m[1], kind: 'poly' };
        m = typeName.match(/^bfloat(16)(?:x\d+)*_t$/);
        if (m) return { bits: 16, kind: 'bfloat' };
        m = typeName.match(/^(?:m?float)(8|16|32|64)(?:x\d+)*_t$/);
        if (m) return { bits: +m[1], kind: 'float' };
        // AVX-512 mask scalars: 1 bit per lane. The cached `values` field
        // is already pre-unfolded into 0/1 entries, so per-lane `bits = 1`
        // matches that shape and the lane renderer prints "0"/"1".
        if (/^__mmask(8|16|32|64)$/.test(typeName)) return { bits: 1, kind: 'mask' };
        return { bits: null, kind: null };
    }

    function tupleCount(typeName) {
        const m = (typeName || '').match(/^[a-z]+\d+x(\d+)x[234]_t$/);
        return m ? +m[1] : 0;
    }

    // Can we generate a valid C++ harness for this record? Excludes
    // pointer params (we don't synthesize input buffers yet). Lives here
    // because the verifier uses it to decide which intrinsics to test.
    function isLiveViewable(rec) {
        if (!rec || !rec.example) return false;
        for (const inp of rec.example.inputs || []) {
            if (/\*/.test(inp.type)) return false;
        }
        // Store-style intrinsics (vst1_*, vst2_*, ...) return void; the
        // database synthesizes a `std::array<T,N>` "virtual" return type
        // representing what got written to the pointer. Our harness can't
        // honor that -- it would need to inject `#include <array>` and
        // rewrite the call site to use a backing buffer + memcpy. Skip
        // these until the harness handles stores explicitly.
        if (/^std::array</.test(rec.example.output && rec.example.output.type || '')) {
            return false;
        }
        return true;
    }

    // Stringify a float so that adding a precision suffix (`f`, `L`) still
    // produces a valid C++ literal. `Number(1).toString()` is "1", which
    // makes "1f" -- not a float literal, just an integer with a stray
    // identifier. Append `.0` whenever the textual form has no decimal /
    // exponent.
    function floatLiteralBody(v) {
        const n = Number(v);
        const s = Number.isFinite(n) ? n.toString() : String(v);
        return (s.includes('.') || s.includes('e') || s.includes('E')) ? s : s + '.0';
    }

    function laneLiteral(v, info) {
        if (info.kind === 'float') {
            if (info.bits === 32) return floatLiteralBody(v) + 'f';
            if (info.bits === 16) return '((__fp16)' + floatLiteralBody(v) + 'f)';
            return floatLiteralBody(v);  // double
        }
        if (info.kind === 'bfloat') return '((__bf16)' + floatLiteralBody(v) + 'f)';
        return String(v);
    }

    // ----- Intel x86 helpers (mirroring scribe.py's intel paths) ----------
    const INTEL_VEC_BYTES = {
        '__m64': 8,
        '__m128': 16, '__m128d': 16, '__m128i': 16, '__m128h': 16, '__m128bh': 16,
        '__m256': 32, '__m256d': 32, '__m256i': 32, '__m256h': 32, '__m256bh': 32,
        '__m512': 64, '__m512d': 64, '__m512i': 64, '__m512h': 64, '__m512bh': 64,
    };
    const INTEL_IMM_TYPES = new Set([
        'const int', 'const unsigned int',
        'int', 'unsigned int', 'unsigned',
        '__int32', '__int8',
    ]);

    function isIntelIntrinsic(name) {
        // `_k*` covers AVX-512 mask-register intrinsics (_kand_mask8,
        // _kor_mask16, _kshiftli_mask*, _kxor_mask*, ...). They use
        // immintrin.h and need the __mmask scalar literal path.
        return /^_(mm|tile|k[a-z])/.test(name || '');
    }

    function intelLaneInfoFor(intrinsicName, cType, context) {
        const bytesTotal = INTEL_VEC_BYTES[cType];
        if (bytesTotal == null) return null;
        // `\b` doesn't fire between a digit and an `_` (both are word chars),
        // so `_epi64_epi8` would only match the trailing `_epi8` in JS regex.
        // Match the Python side (build_db / scribe) and use a lookahead for
        // `_` or end-of-string: that catches both suffixes in
        // `_mm_multishift_epi64_epi8`, `_mm_gf2p8affine_epi64_epi8`, etc.
        const epRe = /_e?p[iu](8|16|32|64)(?=_|$)/g;
        const matches = [];
        let m;
        while ((m = epRe.exec(intrinsicName))) matches.push(m);
        if (matches.length) {
            const pick = context === 'output' ? matches[matches.length - 1] : matches[0];
            const bits = +pick[1];
            const kind = /u/.test(pick[0]) ? 'uint' : 'int';
            return { bits, kind, count: (bytesTotal * 8) / bits };
        }
        if (/_si\d+(?=_|$)/.test(intrinsicName)) return { bits: 8, kind: 'uint', count: bytesTotal };
        if (/_(?:ps|ss)\b/.test(intrinsicName)) return { bits: 32, kind: 'float', count: bytesTotal / 4 };
        if (/_(?:pd|sd)\b/.test(intrinsicName)) return { bits: 64, kind: 'float', count: bytesTotal / 8 };
        if (/_(?:ph|sh)\b/.test(intrinsicName)) return { bits: 16, kind: 'float', count: bytesTotal / 2 };
        if (/_pbh\b/.test(intrinsicName)) return { bits: 16, kind: 'bfloat', count: bytesTotal / 2 };
        if (/d$/.test(cType)) return { bits: 64, kind: 'float', count: bytesTotal / 8 };
        if (/h$/.test(cType)) return { bits: 16, kind: 'float', count: bytesTotal / 2 };
        if (/bh$/.test(cType)) return { bits: 16, kind: 'bfloat', count: bytesTotal / 2 };
        if (cType === '__m128' || cType === '__m256' || cType === '__m512') {
            return { bits: 32, kind: 'float', count: bytesTotal / 4 };
        }
        return { bits: 8, kind: 'uint', count: bytesTotal };
    }

    function intelLaneLiteral(v, info) {
        if (info.kind === 'int' || info.kind === 'uint') {
            return info.bits === 64 ? v + 'LL' : String(v);
        }
        if (info.kind === 'float') {
            if (info.bits === 32) return floatLiteralBody(v) + 'f';
            if (info.bits === 16) return '((__fp16)' + floatLiteralBody(v) + 'f)';
            return floatLiteralBody(v);
        }
        if (info.kind === 'bfloat') return '((__bf16)' + floatLiteralBody(v) + 'f)';
        return String(v);
    }

    // __mmask{8,16,32,64} are scalar typedefs of unsigned char/short/int/long
    // long, not vector types. Brace-init `{0,1,0,1,...}` fails to compile
    // (excess elements in scalar initializer). Pack the 0/1-per-lane `values`
    // LSB-first so lane i ends up in bit i, matching AVX-512 mask semantics
    // (e.g. _mm256_mask_compress_epi32 reads bit i to decide lane i).
    function intelMaskScalarLiteral(values, typeName) {
        let mask = 0n;
        for (let i = 0; i < values.length; i++) {
            if (values[i]) mask |= 1n << BigInt(i);
        }
        const hex = '0x' + mask.toString(16).toUpperCase();
        return /^__mmask64$/.test(typeName) ? hex + 'ULL' : hex;
    }

    function intelSetrCall(values, info) {
        const width = info.bits * info.count;
        const prefix = ({ 128: '_mm', 256: '_mm256', 512: '_mm512' })[width];
        const suffixMap = {
            'int|8':  'epi8',  'int|16':  'epi16',  'int|32':  'epi32',  'int|64':  'epi64x',
            'uint|8': 'epi8',  'uint|16': 'epi16',  'uint|32': 'epi32',  'uint|64': 'epi64x',
            'float|16': 'ph',  'float|32': 'ps',    'float|64': 'pd',
            'bfloat|16': 'pbh',
        };
        const suffix = suffixMap[info.kind + '|' + info.bits];
        if (!prefix || !suffix) {
            throw new Error('no setr builder for ' + info.kind + info.bits + ' x ' + width);
        }
        if (width === 128 && info.bits === 64) {
            // No _mm_setr_epi64x; use _set with reversed args.
            const rev = values.slice().reverse();
            return prefix + '_set_' + suffix + '(' +
                rev.map(v => intelLaneLiteral(v, info)).join(', ') + ')';
        }
        return prefix + '_setr_' + suffix + '(' +
            values.map(v => intelLaneLiteral(v, info)).join(', ') + ')';
    }

    function initList(values, typeName) {
        const info = laneInfo(typeName);
        const tup = tupleCount(typeName);
        if (tup > 0) {
            const subs = [];
            const n = values.length / tup;
            for (let k = 0; k < n; k++) {
                const sub = values.slice(k * tup, (k + 1) * tup);
                subs.push('{' + sub.map(v => laneLiteral(v, info)).join(',') + '}');
            }
            return '{{' + subs.join(',') + '}}';
        }
        return '{' + values.map(v => laneLiteral(v, info)).join(',') + '}';
    }

    // Build a small C++ source that exposes RESULT either as a folded
    // global (read out of .rodata by the asm parser) or by printing
    // its bytes from main() (CE's executor mode picks this up via stdout).
    //
    // We include `<cstdio>` + `main()` only when the target compiler
    // ships a C++ stdlib *and* execution makes sense -- that is, on
    // Intel via godbolt's cclang_trunk. The ARM cross-compiler on godbolt
    // (armv8-full-cclang-trunk) has no stdlib, so we keep the harness
    // header-free; the asm-parse path doesn't need printf.
    //
    // `ceConfigForFn` resolves compiler / march / headers for the given
    // record. Browser callers can omit it -- we default to
    // `window.SimdTooltips.ceConfigFor`, which is already loaded by the
    // tooltip library. Node callers (verifier, tests) pass it explicitly.
    function buildFoldSource(rec, inputValues, ceConfigForFn) {
        const resolveCfg = ceConfigForFn
            || (typeof window !== 'undefined'
                && window.SimdTooltips
                && window.SimdTooltips.ceConfigFor);
        const cfg = resolveCfg && resolveCfg(rec);
        if (!cfg) throw new Error('no Compiler Explorer config for this intrinsic');
        const includes = cfg.headers.map(h => `#include <${h}>`).join('\n');
        const intel = isIntelIntrinsic(rec.name);

        const inputs = rec.example.inputs;
        const decls = [];
        const argParts = [];
        for (let i = 0; i < inputs.length; i++) {
            const inp = inputs[i];
            const vals = inputValues[i];
            const isImm = (intel && INTEL_IMM_TYPES.has(inp.type))
                || /^const\s+(?:unsigned\s+)?int$/.test(inp.type);
            if (isImm) {
                argParts.push(String(vals[0]));
                continue;
            }
            if (intel && /^__mmask(8|16|32|64)$/.test(inp.type)) {
                decls.push(`const ${inp.type} ${inp.name} = ${intelMaskScalarLiteral(vals, inp.type)};`);
            } else if (intel && INTEL_VEC_BYTES[inp.type] != null) {
                const info = intelLaneInfoFor(rec.name, inp.type, 'input');
                decls.push(`const ${inp.type} ${inp.name} = ${intelSetrCall(vals, info)};`);
            } else {
                decls.push(`const ${inp.type} ${inp.name} = ${initList(vals, inp.type)};`);
            }
            argParts.push(inp.name);
        }
        const argList = argParts.join(', ');
        const retType = rec.example.output.type;
        const intelTypedefs = intel
            ? '\n#if !defined(_MSC_VER)\ntypedef long long __int64;\ntypedef int __int32;\ntypedef short __int16;\ntypedef signed char __int8;\n#endif\n'
            : '';
        const stdioHeaders = intel ? '#include <cstdio>\n#include <cstddef>\n' : '';
        const mainFn = intel
            ? '\nint main() {\n' +
              '    const unsigned char* p = reinterpret_cast<const unsigned char*>(&RESULT);\n' +
              '    for (size_t i = 0; i < sizeof(RESULT); i++) std::printf("%02x", p[i]);\n' +
              '    return 0;\n' +
              '}\n'
            : '';
        // Several ARM intrinsics (e.g. vshrn_n_u16, vqshrn_n_*) expand to
        // GCC statement-expressions in arm_neon.h, which the C++ standard
        // forbids at file scope. Wrap the call in an immediately-invoked
        // lambda so the expression evaluates at function scope, where
        // statement-exprs are legal. The clang IR folder still computes
        // RESULT at compile time, so this stays on the fold path.
        const bodyDecls = decls.length ? '    ' + decls.join('\n    ') + '\n' : '';
        return (
            includes + '\n' + stdioHeaders + intelTypedefs + '\n' +
            `extern "C" const ${retType} RESULT = []() -> ${retType} {\n` +
            bodyDecls +
            `    return ${rec.name}(${argList});\n` +
            `}();\n` +
            mainFn
        );
    }

    return {
        laneInfo,
        tupleCount,
        isLiveViewable,
        laneLiteral,
        INTEL_VEC_BYTES,
        INTEL_IMM_TYPES,
        isIntelIntrinsic,
        intelLaneInfoFor,
        intelLaneLiteral,
        intelMaskScalarLiteral,
        intelSetrCall,
        initList,
        buildFoldSource,
    };
});
