/* simd.dev landing page — search box + result card.
 *
 * Loads simd-data.json once on init (it's the source of truth for everything
 * the site shows). All names, type-set, ambiguous-alias map, and per-name
 * arch/family info come from there -- no separate names index needed.
 *
 * Search syntax:
 *   plain tokens          → substring match against the name (case-insensitive)
 *   arch:VALUE            → keep only names whose record.arch list contains VALUE
 *                           (substring-match on each entry, case-insensitive)
 *   family:VALUE          → same as arch but matched against record.family
 *
 * Multiple terms compose with AND. Filter chips below the search box toggle
 * the corresponding `arch:`/`family:` token in the input.
 */

(function () {
    'use strict';

    // Type analysis + C++ harness emitter for the "see on CE" / "update via
    // CE" flow lives in harness.js so a node-side verifier can call the
    // same code path. See simd.dev/harness.js + scripts/verify_ce.* (TBD).
    const {
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
    } = window.SimdHarness;

    const DATA_URL    = 'dist/simd-data.json';
    // We render up to this many result chips. Past this, the user is told
    // the count and asked to refine.
    const MAX_RESULTS = 1000;

    const $q              = document.getElementById('q');
    const $status         = document.getElementById('search-status');
    const $results        = document.getElementById('results');
    const $resultsSection = document.getElementById('results-section');
    const $resultsCount   = document.getElementById('results-count');
    const $card           = document.getElementById('card');
    const $archChips      = document.getElementById('arch-chips');
    const $famChips       = document.getElementById('family-chips');
    const $famToggle      = document.getElementById('family-toggle');

    let allNames = null;       // sorted array of all callable names + ambiguous aliases
    let typeSet  = null;       // Set<string> of names where kind === 'type'
    let records  = null;       // {name: rec}
    let ambiguous = null;      // {alias: [canonical, ...]}
    let clusters = null;       // {cluster_id: [name, ...]} -- variant groups
    const PAGE_TITLE = document.title;

    init().catch(err => {
        $status.textContent = 'failed to load database';
        console.error('simd.dev load failure:', err);
    });

    async function init() {
        $status.textContent = 'loading…';
        const doc = await fetchJSON(DATA_URL);
        records   = doc.records   || {};
        ambiguous = doc.ambiguous || {};
        clusters  = doc.clusters  || {};

        // Names = canonicals (records keys) ∪ ambiguous aliases.
        const set = new Set(Object.keys(records));
        for (const a of Object.keys(ambiguous)) set.add(a);
        allNames = [...set].sort();
        typeSet = new Set();
        for (const [n, r] of Object.entries(records)) if (r.kind === 'type') typeSet.add(n);

        $status.textContent = allNames.length.toLocaleString() + ' indexed';

        renderChips();

        $q.addEventListener('input', onInput);
        $q.addEventListener('keydown', onKeydown);
        $results.addEventListener('click', onResultsClick);
        // Card click delegate: tab headers (open one body, close others),
        // variant chips (load that sibling's card), and family/arch tag
        // chips (toggle the corresponding filter).
        // Select the entire value when an editable cell gets focus
        // (click or tab) so the user can immediately overwrite. Defer
        // with rAF so we run *after* the browser places the caret.
        $card.addEventListener('focusin', (ev) => {
            const cell = ev.target.closest('.ex-cell[contenteditable]');
            if (!cell) return;
            requestAnimationFrame(() => {
                if (document.activeElement !== cell) return;
                const range = document.createRange();
                range.selectNodeContents(cell);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            });
        });

        // When a user edits an input cell (in either dec or hex), mark
        // the output as stale (grayed out) until a fresh "update (via
        // CE)" finishes, AND mirror the value into the sibling cell so
        // the dec and hex spellings stay in sync regardless of which
        // base is currently visible. The status text points at whichever
        // button the user actually has: ↻ update if live recompile is
        // wired up, ↗ see on CE if only the view-harness button is.
        $card.addEventListener('input', (ev) => {
            const cell = ev.target.closest('.ex-cell[contenteditable]');
            if (!cell) return;
            const wrap = cell.closest('.ex-wrap');
            if (wrap) wrap.classList.add('is-stale');
            const status = wrap && wrap.querySelector('.ex-status');
            if (status) {
                const hasRun = !!(wrap && wrap.querySelector('.ex-run'));
                const hasSee = !!(wrap && wrap.querySelector('.ex-see'));
                status.textContent = hasRun
                    ? 'edited — click "↻ update" to recompile'
                    : hasSee
                        ? 'edited — click "↗ see on CE" to recompile'
                        : 'edited';
                status.className = 'ex-status is-stale';
            }
            mirrorEditedSibling(cell);
        });

        $card.addEventListener('click', (ev) => {
            const modeBtn = ev.target.closest('button.ex-mode[data-mode]');
            if (modeBtn) {
                const ex = modeBtn.closest('.ex');
                if (ex) {
                    const isHex = ex.classList.toggle('hex');
                    for (const b of ex.querySelectorAll('button.ex-mode')) {
                        const active = (b.dataset.mode === 'hex') === isHex;
                        b.classList.toggle('is-active', active);
                        b.setAttribute('aria-pressed', active ? 'true' : 'false');
                    }
                }
                return;
            }
            const tab = ev.target.closest('button.card-tab[data-tab]');
            if (tab) {
                const id = tab.dataset.tab;
                const wasActive = tab.getAttribute('aria-expanded') === 'true';
                for (const t of $card.querySelectorAll('button.card-tab')) {
                    t.setAttribute('aria-expanded', 'false');
                }
                for (const b of $card.querySelectorAll('.card-tab-body')) {
                    b.hidden = true;
                }
                if (!wasActive) {
                    tab.setAttribute('aria-expanded', 'true');
                    const body = $card.querySelector('.card-tab-body[data-body="' + id + '"]');
                    if (body) body.hidden = false;
                }
                return;
            }
            const runBtn = ev.target.closest('button.ex-run');
            if (runBtn) {
                ev.preventDefault();
                runOnCE($card.querySelector('.ex'));
                return;
            }
            const seeBtn = ev.target.closest('button.ex-see');
            if (seeBtn) {
                ev.preventDefault();
                seeOnCE($card.querySelector('.ex'));
                return;
            }
            const more = ev.target.closest('button.variants-more');
            if (more) {
                // Reveal the hidden tail of variants and drop the button.
                const tail = more.previousElementSibling;
                if (tail && tail.classList.contains('variants-tail')) tail.hidden = false;
                more.remove();
                return;
            }
            const variant = ev.target.closest('button.variant[data-name]');
            if (variant) {
                // On the dedicated page, navigate to that variant's page;
                // on the compact card, just swap to the variant's card.
                if (document.body.classList.contains('intrinsic-mode')) {
                    const target = variant.dataset.name;
                    history.pushState(null, '', '?intrinsic=' + encodeURIComponent(target));
                    enterIntrinsicPage(target);
                } else {
                    showCard(variant.dataset.name);
                }
                return;
            }
            const filterTag = ev.target.closest('button.tag-filter[data-field]');
            if (filterTag) {
                if (document.body.classList.contains('intrinsic-mode')) {
                    // On the dedicated page, a filter chip means "go to
                    // search filtered by this". Drop the intrinsic param.
                    history.pushState(null, '', './');
                    exitIntrinsicPage({ updateHistory: false });
                }
                toggleFilter(filterTag.dataset.field, filterTag.dataset.value);
            }
            const back = ev.target.closest('a[data-back="1"]');
            if (back) {
                ev.preventDefault();
                exitIntrinsicPage();
                return;
            }
            // Compact-card name → dedicated page (in-place, no reload).
            const nameLink = ev.target.closest('a.name-link');
            if (nameLink) {
                ev.preventDefault();
                const u = new URL(nameLink.href, location.href);
                const target = u.searchParams.get('intrinsic');
                if (target) {
                    history.pushState(null, '', '?intrinsic=' + encodeURIComponent(target));
                    enterIntrinsicPage(target);
                }
                return;
            }
            // Ambiguous-alias variant link inside the dedicated page.
            const ambigLink = ev.target.closest('a[href^="?intrinsic="]');
            if (ambigLink) {
                ev.preventDefault();
                const u = new URL(ambigLink.href, location.href);
                const target = u.searchParams.get('intrinsic');
                if (target) {
                    history.pushState(null, '', '?intrinsic=' + encodeURIComponent(target));
                    enterIntrinsicPage(target);
                }
                return;
            }
        });

        const $home = document.getElementById('home-link');
        if ($home) $home.addEventListener('click', (ev) => {
            // Reset to a clean URL + cleared search state, without a full reload.
            // Falls back to the href attribute if JS fails for any reason.
            ev.preventDefault();
            $q.value = '';
            $card.hidden = true;
            renderResults('');
            refreshChipState();
            history.pushState(null, '', location.pathname + location.search);
            window.scrollTo({ top: 0, behavior: 'smooth' });
            $q.focus();
        });
        document.querySelectorAll('code[data-q]').forEach(c => {
            c.style.cursor = 'pointer';
            c.addEventListener('click', () => {
                $q.value = c.dataset.q;
                $q.focus();
                renderResults($q.value);
                refreshChipState();
            });
        });

        // ?intrinsic=NAME -- dedicated full-page view. Takes priority over
        // the legacy #hash form. Reload-friendly, shareable.
        const params = new URLSearchParams(location.search);
        const intrinsicParam = params.get('intrinsic');
        if (intrinsicParam) {
            enterIntrinsicPage(intrinsicParam);
            return;
        }

        // If the URL has #intrinsic, jump to it.
        if (location.hash.length > 1) {
            const target = decodeURIComponent(location.hash.slice(1));
            if (records[target] || ambiguous[target]) {
                $q.value = target;
                renderResults(target);
                showCard(target);
            }
        }

        $q.focus();
    }

    // Browser back/forward: re-evaluate URL and toggle modes as needed.
    window.addEventListener('popstate', () => {
        const params = new URLSearchParams(location.search);
        const target = params.get('intrinsic');
        if (target) {
            enterIntrinsicPage(target);
        } else if (document.body.classList.contains('intrinsic-mode')) {
            exitIntrinsicPage({ updateHistory: false });
        }
    });

    function onInput() {
        // Any keystroke in the search box should hide the currently-open card --
        // the user is starting a new search, the previous result is stale.
        $card.hidden = true;
        renderResults($q.value);
        refreshChipState();
    }

    function onKeydown(e) {
        if (e.key === 'Enter') {
            const first = $results.querySelector('button');
            if (first) { first.click(); e.preventDefault(); }
        } else if (e.key === 'Escape') {
            $q.value = '';
            renderResults('');
            refreshChipState();
            $card.hidden = true;
        }
    }

    // -------------------------------------------------------------------
    // Query parsing + filtering
    // -------------------------------------------------------------------
    function parseQuery(s) {
        const filters = [];
        const terms = [];
        // Tokens are whitespace-separated, but `arch:"value with spaces"`
        // and `family:"value with spaces"` keep their value as one token.
        const tokens = (s || '').match(
            /(?:arch|family|kind):"[^"]*"|\S+/gi
        ) || [];
        for (const t of tokens) {
            const m = t.match(/^(arch|family|kind):(?:"([^"]*)"|(.+))$/i);
            if (m) {
                const value = (m[2] !== undefined ? m[2] : m[3]).toLowerCase();
                filters.push({ key: m[1].toLowerCase(), value });
            } else {
                terms.push(t.toLowerCase());
            }
        }
        return { filters, terms };
    }

    function quoteIfNeeded(v) {
        return /\s/.test(v) ? `"${v}"` : v;
    }

    function unparseQuery(q) {
        const parts = [];
        for (const f of q.filters) parts.push(f.key + ':' + quoteIfNeeded(f.value));
        for (const t of q.terms) parts.push(t);
        return parts.join(' ');
    }

    // uops.info search URL template: latency / throughput / uop count /
    // port distribution on a configurable set of microarchs. Defaults
    // here cover recent Intel (Arrow Lake P + E cores) and AMD (Zen 5),
    // with all SIMD categories enabled so any mnemonic finds matches.
    // The user can toggle more microarchs on the page itself.
    function uopsInfoUrl(mnemonic) {
        const m = (mnemonic || '').toLowerCase();
        return 'https://uops.info/table.html?search=' + encodeURIComponent(m)
            + '&cb_lat=on&cb_tp=on&cb_uops=on&cb_ports=on'
            + '&cb_ARLP=on&cb_ARLE=on&cb_ZEN5=on'
            + '&cb_measurements=on&cb_doc=on'
            + '&cb_base=on&cb_aes=on&cb_avx=on&cb_avx2=on&cb_avx512=on'
            + '&cb_bmi=on&cb_fma=on&cb_mmx=on&cb_sse=on&cb_x87=on';
    }

    // ---- "Related" index: union of pseudocode-cluster siblings and
    // names whose digit-positions can be substituted to reach this one
    // (e.g. _mm_add_epi32 ↔ _mm_add_epi8/16/64). The template index is
    // built lazily on first lookup and cached. It's purely a UI-side
    // computation -- no data-side schema change.
    let _templateIndex = null;
    function _buildTemplateIndex() {
        const idx = Object.create(null);
        for (const n of Object.keys(records)) {
            const tpl = n.replace(/\d+/g, '#');
            (idx[tpl] || (idx[tpl] = [])).push(n);
        }
        _templateIndex = idx;
    }
    function relatedNames(name, rec) {
        const set = new Set();
        if (rec && rec.cluster && clusters && clusters[rec.cluster]) {
            for (const s of clusters[rec.cluster]) if (s !== name) set.add(s);
        }
        if (!_templateIndex) _buildTemplateIndex();
        const tpl = name.replace(/\d+/g, '#');
        const tplList = _templateIndex[tpl];
        if (tplList) for (const s of tplList) if (s !== name) set.add(s);
        return [...set].sort();
    }

    function recordMetaFor(name) {
        // Returns { archs, families } for a name. For ambiguous aliases, union
        // the targets' arch/family.
        const r = records[name];
        if (r) return { archs: r.arch || [], families: r.family || [] };
        const targets = ambiguous[name];
        if (!targets) return { archs: [], families: [] };
        const aset = new Set(), fset = new Set();
        for (const t of targets) {
            const tr = records[t];
            if (!tr) continue;
            for (const a of tr.arch || []) aset.add(a);
            for (const f of tr.family || []) fset.add(f);
        }
        return { archs: [...aset], families: [...fset] };
    }

    function passesFilters(name, filters) {
        if (filters.length === 0) return true;
        const meta = recordMetaFor(name);
        const rec = records[name];
        for (const f of filters) {
            const v = f.value;
            if (f.key === 'kind') {
                // Today the only meaningful kind is "type" (the 208 SIMD
                // type records). Everything else is an intrinsic.
                const k = (rec && rec.kind) ? rec.kind : 'intrinsic';
                if (k !== v) return false;
                continue;
            }
            const list = f.key === 'arch' ? meta.archs : meta.families;
            if (!list.some(x => x.toLowerCase().indexOf(v) >= 0)) return false;
        }
        return true;
    }

    // -------------------------------------------------------------------
    // Results
    // -------------------------------------------------------------------
    function renderResults(query) {
        $results.innerHTML = '';
        $resultsCount.textContent = '';
        if (!records) { $resultsSection.hidden = true; return; }
        const q = parseQuery(query || '');

        // No terms and no filters → hide the section entirely (don't dump
        // the whole catalog).
        if (q.terms.length === 0 && q.filters.length === 0) {
            $resultsSection.hidden = true;
            return;
        }

        // Collect *all* matches across the whole catalog (no early break) so
        // the total count is accurate. Render up to MAX_RESULTS.
        //
        // Multi-word terms compose with AND on substring match, so e.g.
        // "add f16" matches vpadd_f16 (both 'add' and 'f16' appear in the
        // name) but not vadd_s8 (no 'f16').
        const exact = [], prefix = [], sub = [];
        const terms = q.terms;
        for (const n of allNames) {
            if (!passesFilters(n, q.filters)) continue;

            const ln = n.toLowerCase();
            if (terms.length === 0) { sub.push(n); continue; }

            let allMatch = true;
            for (const t of terms) {
                if (ln.indexOf(t) < 0) { allMatch = false; break; }
            }
            if (!allMatch) continue;

            // Rank: exact name match (single-term), prefix on any term, else sub.
            if (terms.length === 1 && ln === terms[0]) exact.push(n);
            else if (terms.some(t => ln.startsWith(t))) prefix.push(n);
            else sub.push(n);
        }
        const ranked = [...exact, ...prefix, ...sub];
        const total = ranked.length;
        const visible = ranked.slice(0, MAX_RESULTS);

        $resultsSection.hidden = false;

        if (total === 0) {
            $resultsCount.textContent = 'no matches';
            const li = document.createElement('li');
            li.innerHTML = '<span class="muted" style="padding:3px 6px;">no matches</span>';
            $results.appendChild(li);
            return;
        }

        $resultsCount.textContent = total > MAX_RESULTS
            ? `showing ${MAX_RESULTS.toLocaleString()} of ${total.toLocaleString()} — refine to narrow down`
            : `${total.toLocaleString()} match${total === 1 ? '' : 'es'}`;

        const frag = document.createDocumentFragment();
        for (const n of visible) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = n;
            btn.dataset.name = n;
            if (typeSet.has(n)) btn.classList.add('is-type');
            li.appendChild(btn);
            frag.appendChild(li);
        }
        $results.appendChild(frag);
    }

    function onResultsClick(ev) {
        const btn = ev.target.closest('button[data-name]');
        if (!btn) return;
        showCard(btn.dataset.name);
    }

    function showCard(name) {
        const rec = records[name];
        const ambig = ambiguous[name];
        if (!rec && ambig) {
            const list = ambig.slice(0, 8).map(n => `<code>${escapeHtml(n)}</code>`).join(', ');
            const more = ambig.length > 8 ? ` <em>+${ambig.length - 8} more</em>` : '';
            $card.innerHTML = `<div class="card-head"><span class="name">${escapeHtml(name)}</span> <span class="tag">overloaded</span></div>
                <div>Resolves to ${ambig.length} typed variants: ${list}${more}</div>`;
            $card.hidden = false;
            $card.classList.remove('is-type');
            history.replaceState(null, '', '#' + encodeURIComponent(name));
            $card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return;
        }
        if (!rec) {
            $card.innerHTML = `<div class="muted"><code>${escapeHtml(name)}</code> not in database.</div>`;
            $card.hidden = false;
            return;
        }
        $card.innerHTML = renderCardHTML(name, rec);
        $card.hidden = false;
        $card.classList.toggle('is-type', rec.kind === 'type');
        history.replaceState(null, '', '#' + encodeURIComponent(name));
        $card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (window.SimdTooltips && window.SimdTooltips.scan) {
            window.SimdTooltips.scan($card);
        }
    }

    // opts:
    //   expanded -- if true, render every section open and labeled
    //               (no tab buttons); used by the dedicated /?intrinsic
    //               page. If false (default), render the compact card
    //               with the tabbed UI.
    function renderCardHTML(name, rec, opts = {}) {
        const expanded = !!opts.expanded;

        const tags = [];
        if (rec.kind === 'type') tags.push(`<span class="tag kind">type</span>`);
        if (rec.kind === 'scalar') tags.push(`<span class="tag kind" title="Scalar bit-manipulation, not SIMD">scalar</span>`);
        for (const f of rec.family || []) {
            const filterValue = f.toLowerCase();
            tags.push(`<button type="button" class="tag tag-filter" data-field="family" data-value="${escapeAttr(filterValue)}" title="filter family:${escapeAttr(filterValue)}">${escapeHtml(f)}</button>`);
        }
        for (const a of rec.arch || []) {
            tags.push(`<button type="button" class="tag tag-filter arch" data-field="arch" data-value="${escapeAttr(a.toLowerCase())}" title="filter arch:${escapeAttr(a)}">${escapeHtml(a)}</button>`);
        }

        // Sections: pseudocode + example + variants. In compact mode they
        // share a tab row (mutually exclusive). In expanded mode each is
        // a labeled, always-visible section.
        const sections = [];
        if (rec.pseudocode) {
            sections.push({ id: 'pc', label: 'pseudocode',
                body: `<pre class="card-pc-body">${escapeHtml(rec.pseudocode)}</pre>` });
        }
        if (rec.example) {
            sections.push({ id: 'ex', label: 'example',
                body: renderExample(rec.example, name) });
        } else if (rec.kind !== 'type') {
            sections.push({ id: 'ex', label: 'example',
                body: renderNoExample(name, rec) });
        }
        const siblings = relatedNames(name, rec);
        if (siblings.length > 0) {
            const VAR_LIMIT = 50;
            const head = siblings.slice(0, VAR_LIMIT);
            const tail = siblings.slice(VAR_LIMIT);
            const chip = n => `<button type="button" class="variant" data-name="${escapeAttr(n)}">${escapeHtml(n)}</button>`;
            let html = head.map(chip).join('');
            if (tail.length) {
                html += `<span class="variants-tail" hidden>${tail.map(chip).join('')}</span>`;
                html += `<button type="button" class="variants-more" data-more="1">+${tail.length} more</button>`;
            }
            sections.push({ id: 'vars', label: siblings.length + ' related',
                body: `<div class="variants-list">${html}</div>` });
        }
        // ARM perf table: on the dedicated /?intrinsic page only, render
        // a placeholder section that lazy-loads arm-perf.json and
        // populates it. We don't want this in compact card / tooltip mode
        // (too much vertical real estate) and we don't want it preloaded
        // alongside the main data file.
        if (expanded && rec.source === 'arm-acle') {
            sections.push({ id: 'perf', label: 'asm perf',
                body: `<div class="arm-perf" data-intrinsic="${escapeAttr(name)}">`
                    + `<div class="arm-perf-loading">loading...</div></div>` });
        }
        // Intel perf table: the iguide page lazy-loads a 445 KB perf2.js
        // assigning to `window.perf2_js`, keyed by XED operand-form
        // (PADDD_XMMdq_XMMdq, ...). Our build already captures the xed
        // attribute; same lazy-load pattern, no copy of Intel's data
        // shipped from our origin.
        if (expanded && rec.source === 'intel-iguide' && rec.xed) {
            sections.push({ id: 'perf', label: 'asm perf',
                body: `<div class="intel-perf" data-xed="${escapeAttr(rec.xed)}">`
                    + `<div class="arm-perf-loading">loading...</div></div>` });
        }

        let body = '';
        if (sections.length) {
            if (expanded) {
                // Dedicated-page mode: each section is a <details open> so
                // the user can collapse what they don't want without
                // losing the others. All open by default.
                body = sections.map(s =>
                    `<details class="card-section" data-section="${s.id}" open>
                        <summary class="card-section-title">${s.label}</summary>
                        ${s.body}
                    </details>`
                ).join('');
            } else {
                const headers = sections.map(s =>
                    `<button type="button" class="card-tab" data-tab="${s.id}" aria-expanded="false">${s.label}</button>`
                ).join('');
                const bodies = sections.map(s =>
                    `<div class="card-tab-body" data-body="${s.id}" hidden>${s.body}</div>`
                ).join('');
                body = `<div class="card-toggles">${headers}${bodies}</div>`;
            }
        }

        const linkLabel = rec.source === 'arm-acle' ? 'Arm developer docs →' : 'Intel Intrinsics Guide →';
        const links = [];
        if (rec.doc_url) links.push(`<a class="upstream-link" href="${escapeAttr(rec.doc_url)}" target="_blank" rel="noopener">${linkLabel}</a>`);
        // Felix Cloutier mirror of the Intel SDM for the underlying
        // asm mnemonic -- only emitted by the build for Intel intrinsics
        // that lower to a single Felix-indexed instruction. Show the
        // mnemonic in the label so the user knows what's on the page.
        if (rec.felix_url) {
            const m = rec.felix_url.split('/').pop().split(':')[0].toUpperCase();
            links.push(`<a class="upstream-link" href="${escapeAttr(rec.felix_url)}" target="_blank" rel="noopener" title="Intel SDM (Felix Cloutier mirror)">asm: ${escapeHtml(m)} →</a>`);
        }
        // uops.info: measured latency/throughput/uops/ports across recent
        // Intel + AMD microarchs. One mnemonic often has several
        // operand-form variants (XMM,XMM,M128 vs XMM,XMM,XMM, ...);
        // search-based URL aggregates them.
        if (rec.asm_mnemonic) {
            const u = uopsInfoUrl(rec.asm_mnemonic);
            links.push(`<a class="upstream-link" href="${escapeAttr(u)}" target="_blank" rel="noopener" title="uops.info — measured latency/throughput/uops/ports per microarch">perf: ${escapeHtml(rec.asm_mnemonic)} →</a>`);
        }
        const ceUrl = (window.SimdTooltips && window.SimdTooltips.compilerExplorerUrl)
            ? window.SimdTooltips.compilerExplorerUrl(rec)
            : null;
        if (ceUrl) links.push(`<a class="upstream-link" href="${escapeAttr(ceUrl)}" target="_blank" rel="noopener">Compiler Explorer →</a>`);
        const link = links.length ? `<div class="upstream-links">${links.join(' &middot; ')}</div>` : '';

        const desc = rec.description ? `<div class="description">${escapeHtml(rec.description)}</div>` : '';
        // Compact card: name links to the dedicated /?intrinsic page.
        // Expanded page: name is plain text (we're already on its page).
        const nameNode = expanded
            ? `<span class="name">${escapeHtml(name)}</span>`
            : `<a class="name name-link" href="?intrinsic=${encodeURIComponent(name)}">${escapeHtml(name)}</a>`;
        // Top-right "open dedicated page" link on the compact card.
        const openLink = expanded
            ? ''
            : `<a class="card-open name-link" href="?intrinsic=${encodeURIComponent(name)}" title="Open dedicated page">↗</a>`;

        return `
            <div class="card-head">
                ${nameNode}
                ${tags.join(' ')}
                ${openLink}
            </div>
            <pre class="signature">${escapeHtml(rec.definition || '')}</pre>
            ${desc}
            ${body}
            ${link}
        `;
    }

    function renderIntrinsicPageHTML(name, rec) {
        const back = `<nav class="page-nav"><a href="./" data-back="1">← back to search</a></nav>`;
        const lr = liveRunnability(rec);
        _renderExampleViewable = isLiveViewable(rec);
        _renderExampleRunnable = lr.runnable;
        _renderExampleNoRunReason = lr.reason;
        try {
            return back + renderCardHTML(name, rec, { expanded: true });
        } finally {
            _renderExampleViewable = false;
            _renderExampleRunnable = false;
            _renderExampleNoRunReason = null;
        }
    }

    function enterIntrinsicPage(name) {
        const rec = records[name];
        const ambig = ambiguous[name];
        document.body.classList.add('intrinsic-mode');
        $card.classList.add('card-page');
        $card.hidden = false;
        if (!rec && ambig) {
            const list = ambig.slice(0, 8).map(n => `<a href="?intrinsic=${encodeURIComponent(n)}"><code>${escapeHtml(n)}</code></a>`).join(', ');
            const more = ambig.length > 8 ? ` <em>+${ambig.length - 8} more</em>` : '';
            $card.innerHTML = `<nav class="page-nav"><a href="./" data-back="1">← back to search</a></nav>
                <div class="card-head"><span class="name">${escapeHtml(name)}</span> <span class="tag">overloaded</span></div>
                <div>Resolves to ${ambig.length} typed variants: ${list}${more}</div>`;
        } else if (!rec) {
            $card.innerHTML = `<nav class="page-nav"><a href="./" data-back="1">← back to search</a></nav>
                <div class="muted"><code>${escapeHtml(name)}</code> not in database.</div>`;
        } else {
            $card.innerHTML = renderIntrinsicPageHTML(name, rec);
            $card.classList.toggle('is-type', rec.kind === 'type');
        }
        document.title = name + ' · simd.dev';
        window.scrollTo({ top: 0 });
        // The tooltip lib walks + wraps intrinsic names at init; content
        // we just inserted into the page card hasn't been scanned. Re-scan
        // so hovers fire on the pseudocode + variants list.
        if (window.SimdTooltips && window.SimdTooltips.scan) {
            window.SimdTooltips.scan($card);
        }
        // Lazy-load the per-microarch perf table for ARM intrinsics
        // (from our pre-baked dist/arm-perf.json) and for Intel ones
        // (live from Intel's perf2.js).
        hydrateArmPerf($card).catch(() => {});
        hydrateIntelPerf($card).catch(() => {});
        hydrateCeVerify($card).catch(() => {});
    }

    function exitIntrinsicPage(opts = {}) {
        document.body.classList.remove('intrinsic-mode');
        $card.classList.remove('card-page');
        $card.classList.remove('is-type');
        $card.hidden = true;
        $card.innerHTML = '';
        document.title = PAGE_TITLE;
        if (opts.updateHistory !== false) {
            history.pushState(null, '', './');
        }
    }

    // -------------------------------------------------------------------
    // Filter chips
    // -------------------------------------------------------------------
    function renderChips() {
        const archCount = new Map();
        const famCount = new Map();
        for (const [n, r] of Object.entries(records)) {
            for (const a of r.arch   || []) archCount.set(a, (archCount.get(a) || 0) + 1);
            for (const f of r.family || []) famCount.set(f, (famCount.get(f) || 0) + 1);
        }
        const fmt = n => n.toLocaleString();
        const sortByCount = m => [...m.entries()].sort((a, b) => b[1] - a[1]);

        const archEntries = sortByCount(archCount);
        const famEntries  = sortByCount(famCount);

        $archChips.innerHTML = archEntries.map(([name, count]) => chipHtml('arch', name, count)).join('');
        $famChips.innerHTML  = famEntries.map(([name, count])  => chipHtml('family', name, count)).join('');

        $archChips.addEventListener('click', onChipClick);
        $famChips.addEventListener('click', onChipClick);

        // Family chip row is collapsed by default (~80 families). The toggle
        // expands the row to show all of them.
        if ($famToggle) {
            $famToggle.addEventListener('click', () => {
                const expanded = $famChips.classList.toggle('expanded');
                $famToggle.textContent = expanded ? 'less…' : 'more…';
                $famToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            });
        }
    }

    function chipHtml(field, label, count, filterValueOverride) {
        const value = filterValueOverride || label;
        return `<button type="button" class="chip" data-field="${field}" data-value="${escapeAttr(value.toLowerCase())}" title="${escapeAttr(field + ':' + value)}">${escapeHtml(label)} <span class="chip-count">(${count.toLocaleString()})</span></button>`;
    }

    function onChipClick(ev) {
        const btn = ev.target.closest('button.chip');
        if (!btn) return;
        const field = btn.dataset.field;
        const value = btn.dataset.value;
        toggleFilter(field, value);
    }

    function toggleFilter(field, value) {
        // Chip clicks aren't composable -- they reset the query to just this
        // single filter (or clear it entirely when toggling off the active chip).
        // Any other content the user had typed gets wiped.
        const q = parseQuery($q.value);
        const isActive = q.filters.some(f => f.key === field && f.value === value);
        $q.value = isActive ? '' : (field + ':' + quoteIfNeeded(value));
        $card.hidden = true;
        renderResults($q.value);
        refreshChipState();
        $q.focus();
    }

    function refreshChipState() {
        const q = parseQuery($q.value);
        const active = new Set(q.filters.map(f => f.key + ':' + f.value));
        for (const btn of document.querySelectorAll('button.chip')) {
            const key = btn.dataset.field + ':' + btn.dataset.value;
            btn.classList.toggle('active', active.has(key));
        }
    }

    // -------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------
    async function fetchJSON(url) {
        const r = await fetch(url, { credentials: 'omit' });
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.json();
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // -------------------------------------------------------------------
    // Type introspection (shared between renderExample and the live-edit
    // CE flow). Hoisted to module scope so both can use them.
    // -------------------------------------------------------------------
    // -------------------------------------------------------------------
    // Live "edit + run on Compiler Explorer" for fold-eligible intrinsics
    // on the dedicated /?intrinsic page.
    // -------------------------------------------------------------------

    // Two-level eligibility:
    //
    //   isLiveViewable -- can we generate a valid C++ harness so "see on
    //                     CE" links work? Excludes pointer params (we
    //                     don't synthesize input buffers yet). Lives in
    //                     harness.js because the verifier needs it too.
    //   isLiveRunnable -- can we round-trip via CE's compile API and
    //                     parse RESULT bytes back? Requires the cached
    //                     entry to have come from the fold path so we
    //                     can read .rodata directly. (Execute-verified
    //                     entries can still be opened in CE for
    //                     inspection -- the user just won't get a live
    //                     re-decoded output row.)
    function isLiveRunnable(rec) {
        return liveRunnability(rec).runnable;
    }

    // Returns { runnable: bool, reason: string | null }. The reason is
    // surfaced in the UI under the example so users know *why* the
    // "update (via CE)" button is missing.
    function liveRunnability(rec) {
        if (!isLiveViewable(rec)) {
            return {
                runnable: false,
                reason: 'Live update needs editable input vectors; this '
                    + "intrinsic takes a pointer, which the harness can't "
                    + 'synthesize yet.',
            };
        }
        const v = rec.example.verified_via;
        // Intel `execute` records can re-run via CE's executor mode (CE
        // ships an executor backend for x86). For ARM, CE's compilers
        // are cross-compilers with no executor -- so `execute` records
        // are doomed to silent .zero output via the fold path. Suppress
        // the live-update button there; "see on CE" still works for
        // inspection.
        if (v === 'fold') return { runnable: true, reason: null };
        if (v === 'execute' && isIntelIntrinsic(rec.name)) {
            return { runnable: true, reason: null };
        }
        if (v === 'execute') {
            return {
                runnable: false,
                reason: "Clang's IR folder doesn't model this op (saturating, "
                    + "table-lookup, crypto, ...), and CE's ARM cross-compilers "
                    + 'have no executor backend, so a re-run can\'t produce the '
                    + 'result here. The cached values were verified by linking '
                    + '+ running locally; click "↗ see on CE" to inspect the '
                    + 'asm.',
            };
        }
        return {
            runnable: false,
            reason: 'No verified worked example was found for this intrinsic.',
        };
    }

    // Parse `data.asm` (CE's structured asm output) and pull the bytes
    // that follow the `RESULT:` label until the next label or directive
    // we don't recognize. Returns a Uint8Array of `byteCount` bytes.
    function parseRodataBytes(asmLines, byteCount) {
        const text = asmLines.map(l => (typeof l === 'string' ? l : l.text || '')).join('\n');
        const lines = text.split('\n').map(s => s.trim());
        let i = lines.findIndex(l => /^_?RESULT:\s*$/.test(l));
        if (i < 0) throw new Error('RESULT label not found in asm');
        const out = [];
        for (i++; i < lines.length && out.length < byteCount; i++) {
            const t = lines[i];
            if (!t || t.startsWith('//') || t.startsWith('#')) continue;
            let m;
            if ((m = t.match(/^\.byte\s+(.+)$/))) {
                for (const v of m[1].split(',').map(s => s.trim())) {
                    out.push(parseInt(v, v.startsWith('0x') ? 16 : 10) & 0xff);
                }
                continue;
            }
            if ((m = t.match(/^\.short\s+(.+)$/)) || (m = t.match(/^\.hword\s+(.+)$/))) {
                for (const v of m[1].split(',').map(s => s.trim())) {
                    const u = parseInt(v, v.startsWith('0x') ? 16 : 10) & 0xffff;
                    out.push(u & 0xff, (u >>> 8) & 0xff);
                }
                continue;
            }
            if ((m = t.match(/^\.long\s+(.+)$/)) || (m = t.match(/^\.word\s+(.+)$/))) {
                for (const v of m[1].split(',').map(s => s.trim())) {
                    const u = parseInt(v, v.startsWith('0x') ? 16 : 10) >>> 0;
                    out.push(u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff);
                }
                continue;
            }
            if ((m = t.match(/^\.quad\s+(.+)$/)) || (m = t.match(/^\.xword\s+(.+)$/))) {
                for (const v of m[1].split(',').map(s => s.trim())) {
                    let n = BigInt(v);
                    if (n < 0n) n = (1n << 64n) + n;
                    for (let k = 0; k < 8; k++) out.push(Number((n >> BigInt(k * 8)) & 0xffn));
                }
                continue;
            }
            if ((m = t.match(/^\.zero\s+(\d+)/))) {
                // A leading `.zero` directly under RESULT: means RESULT
                // landed in BSS -- clang couldn't constant-fold the call.
                // The bytes are runtime-zeroed, not actual results, so
                // surface a clear error instead of returning all-zeros.
                if (out.length === 0) {
                    throw new Error(
                        "constant-fold failed -- this intrinsic doesn't fold "
                        + "at compile time on Compiler Explorer's clang. "
                        + "The cached worked example was verified by linking "
                        + "and running locally; CE's iframe can only show "
                        + "static .rodata bytes."
                    );
                }
                for (let k = 0; k < parseInt(m[1], 10); k++) out.push(0);
                continue;
            }
            if (/^\.(?:size|type|globl|p2align|align|section)/.test(t)) continue;
            if (/^[._A-Za-z]\w*:\s*$/.test(t)) break;  // next label
            if (t.startsWith('.')) break;               // unknown directive
        }
        if (out.length < byteCount) {
            throw new Error(
                `expected ${byteCount} bytes, parsed ${out.length}`
            );
        }
        return new Uint8Array(out.slice(0, byteCount));
    }

    function ceBase64Url(s) {
        return btoa(unescape(encodeURIComponent(s)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function ceClientstateUrl(rec, inputValues) {
        const cfg = window.SimdTooltips.ceConfigFor(rec);
        if (!cfg) return null;
        const source = buildFoldSource(rec, inputValues);
        // Stay on `language: 'c'`: godbolt's compiler IDs are
        // language-scoped, and our ARM/Intel compilers
        // (armv8-full-cclang-trunk, cclang_trunk, ...) are catalogued
        // under c. Setting c++ here makes godbolt drop our compiler and
        // fall back to its default c++ one (which is delightful but not
        // what we want). `-x c++` in the options keeps the compile in
        // C++ mode, where dynamic-init globals are legal.
        const state = {
            sessions: [{
                id: 1, language: 'c', source,
                compilers: [{
                    id: cfg.compiler, options: cfg.options + ' -x c++', libs: [],
                    filters: {
                        binary: false, commentOnly: true, demangle: true, directives: true,
                        execute: false, intel: false, labels: true, libraryCode: false, trim: false,
                    },
                }],
            }],
            version: 4,
        };
        return 'https://godbolt.org/clientstate/' + ceBase64Url(JSON.stringify(state));
    }

    // Mode is "fold" (read RESULT bytes out of .rodata in the asm) or
    // "execute" (CE's executor runs the binary; we parse stdout, which
    // is the hex-printed bytes from main()).
    //
    // Execute mode only applies when the target compiler on godbolt
    // ships both libstdc++ *and* an executor backend -- currently
    // Intel via cclang_trunk. ARM cross-compilers on godbolt have
    // neither, so we always try fold mode for ARM and let CE's
    // clang-trunk constant-fold what it can (which is more than our
    // local macOS arm64 clang does, e.g. table lookups).
    async function ceCompileFold(rec, inputValues) {
        const intel = isIntelIntrinsic(rec.name);
        const mode = (intel && rec.example.verified_via === 'execute')
            ? 'execute' : 'fold';
        const cfg = window.SimdTooltips && window.SimdTooltips.ceConfigFor(rec);
        if (!cfg) throw new Error('no Compiler Explorer config');
        const source = buildFoldSource(rec, inputValues);
        const resp = await fetch(
            'https://godbolt.org/api/compiler/' + encodeURIComponent(cfg.compiler) + '/compile',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({
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
                }),
            }
        );
        if (!resp.ok) throw new Error('CE returned HTTP ' + resp.status);
        const data = await resp.json();
        if (mode === 'execute') {
            // The executor wraps the build+run; status lives at the
            // outer level (data.code) for build status and
            // data.execResult.code for run status.
            const exec = data.execResult || data;
            if (exec.buildResult && exec.buildResult.code !== 0) {
                const stderr = (exec.buildResult.stderr || []).map(l => l.text || l).join('\n');
                throw new Error('clang error: ' + stderr.slice(0, 240));
            }
            if (exec.code !== 0) {
                const stderr = (exec.stderr || []).map(l => l.text || l).join('\n');
                throw new Error('run error (exit ' + exec.code + '): ' + (stderr || '').slice(0, 240));
            }
            const out = (exec.stdout || []).map(l => l.text || l).join('').trim();
            if (!/^[0-9a-fA-F]+$/.test(out)) {
                throw new Error('unexpected stdout: ' + out.slice(0, 120));
            }
            const expected = expectedOutputBytes(rec);
            if (out.length < expected * 2) {
                throw new Error('expected ' + expected + ' bytes, got ' + (out.length / 2));
            }
            const bytes = new Uint8Array(expected);
            for (let i = 0; i < expected; i++) bytes[i] = parseInt(out.slice(i * 2, i * 2 + 2), 16);
            return { bytes, source };
        }
        if (data.code !== 0) {
            const stderr = (data.stderr || []).map(l => l.text || l).join('\n');
            throw new Error('clang error: ' + stderr.slice(0, 240));
        }
        const expected = expectedOutputBytes(rec);
        const bytes = parseRodataBytes(data.asm || [], expected);
        return { bytes, source };
    }

    function expectedOutputBytes(rec) {
        // We trust the cached output's byte length -- it tells us how
        // many bytes RESULT occupies for this intrinsic.
        return Math.floor(rec.example.output.bytes_hex.length / 2);
    }

    function decodeOutput(rec, bytes) {
        const out = rec.example.output;
        let bits, kind, count;
        // For Intel `__m128i` etc. the lane shape comes from the
        // intrinsic name suffix, not the C type.
        if (isIntelIntrinsic(rec.name) && INTEL_VEC_BYTES[out.type] != null) {
            const info = intelLaneInfoFor(rec.name, out.type, 'output');
            bits = info.bits; kind = info.kind; count = info.count;
        } else {
            ({ bits, kind } = laneInfo(out.type));
            count = bits ? (bytes.length * 8) / bits : 0;
        }
        if (!bits) return [];
        const values = [];
        const lb = bits / 8;
        for (let i = 0; i < count; i++) {
            const slice = bytes.slice(i * lb, (i + 1) * lb);
            values.push(decodeLaneBytes(slice, bits, kind));
        }
        return values;
    }

    // Clamp an integer lane value to its representable range. Intel
    // suffixes use the `epu` flag for unsigned vs `epi` for signed; for
    // ARM the `kind` field already disambiguates.
    function clampIntegerLane(v, bits, kind) {
        if (kind === 'uint' || kind === 'poly' || kind === 'mask') {
            const lo = 0n, hi = (1n << BigInt(bits)) - 1n;
            const b = BigInt(v);
            if (b < lo) return Number(lo);
            if (b > hi) return Number(hi);
            return v;
        }
        // signed
        const lo = -(1n << BigInt(bits - 1));
        const hi = (1n << BigInt(bits - 1)) - 1n;
        const b = BigInt(v);
        if (b < lo) return Number(lo);
        if (b > hi) return Number(hi);
        return v;
    }

    // Decode the hex-cell text back to a lane value. The hex spelling
    // we render is little-endian byte-major (see hexFromBytes) for
    // outputs, but for inputs it comes from hexFromValue which writes
    // the integer in big-endian hex (no byte-reverse). We only need to
    // support the input shape here, so big-endian hex of the value.
    function parseHexLane(text, bits, kind) {
        const t = text.replace(/^0x/i, '').replace(/\s+/g, '');
        if (kind === 'float' || kind === 'bfloat') {
            // Hex bytes laid out as IEEE binary; we just round-trip.
            // 16-bit fp: padStart to 4; 32-bit: 8; 64-bit: 16.
            const len = bits / 4;
            if (!new RegExp(`^[0-9a-fA-F]{1,${len}}$`).test(t)) {
                throw new Error('not hex: "' + text + '"');
            }
            const padded = t.padStart(len, '0');
            const buf = new ArrayBuffer(bits / 8);
            const u = new Uint8Array(buf);
            for (let i = 0; i < bits / 8; i++) {
                u[i] = parseInt(padded.slice((bits / 8 - 1 - i) * 2,
                                             (bits / 8 - i) * 2), 16);
            }
            if (kind === 'bfloat') {
                const u16 = new Uint16Array(buf)[0];
                const f32buf = new ArrayBuffer(4);
                new Uint32Array(f32buf)[0] = u16 << 16;
                return new Float32Array(f32buf)[0];
            }
            if (bits === 16 && typeof Float16Array !== 'undefined') {
                return new Float16Array(buf)[0];
            }
            if (bits === 32) return new Float32Array(buf)[0];
            if (bits === 64) return new Float64Array(buf)[0];
        }
        if (!/^[0-9a-fA-F]+$/.test(t)) {
            throw new Error('not hex: "' + text + '"');
        }
        // For signed types, treat the hex as the two\'s-complement bit
        // pattern at this width: high bit = sign.
        if (bits <= 32) {
            const u = parseInt(t, 16) >>> 0;
            const mask = bits === 32 ? 0xffffffff : ((1 << bits) - 1);
            const masked = u & mask;
            if (kind === 'int' && (masked >>> (bits - 1)) & 1) {
                return masked - (1 << bits);
            }
            return masked;
        }
        let n = BigInt('0x' + t);
        const w = BigInt(bits);
        n = n & ((1n << w) - 1n);
        if (kind === 'int' && (n >> (w - 1n))) n -= (1n << w);
        return Number(n);
    }

    // Find the rec for the example block currently shown -- either via
    // the dedicated /?intrinsic page URL or the compact card hash.
    function recForLiveExample() {
        const params = new URLSearchParams(location.search);
        const fromParam = params.get('intrinsic');
        if (fromParam && records[fromParam]) return records[fromParam];
        const fromHash = location.hash.length > 1
            ? decodeURIComponent(location.hash.slice(1))
            : null;
        if (fromHash && records[fromHash]) return records[fromHash];
        return null;
    }

    // Local re-implementation of the dec→hex round-trip from
    // renderExample. Pulled out so the live-edit handler can call it
    // without re-rendering the whole row.
    function _hexFromValueLocal(v, bits, kind) {
        if (bits == null) return String(v);
        const len = bits / 4;
        if (kind === 'float' || kind === 'bfloat') {
            const f = Number(v);
            if (kind === 'bfloat') {
                const buf = new ArrayBuffer(4);
                new Float32Array(buf)[0] = f;
                const u = new Uint32Array(buf)[0];
                return ((u >>> 16) & 0xffff).toString(16).padStart(4, '0');
            }
            if (bits === 32) {
                const buf = new ArrayBuffer(4);
                new Float32Array(buf)[0] = f;
                return new Uint32Array(buf)[0].toString(16).padStart(8, '0');
            }
            if (bits === 64) {
                const buf = new ArrayBuffer(8);
                new Float64Array(buf)[0] = f;
                return new BigUint64Array(buf)[0].toString(16).padStart(16, '0');
            }
            if (bits === 16 && typeof Float16Array !== 'undefined') {
                const buf = new ArrayBuffer(2);
                new Float16Array(buf)[0] = f;
                return new Uint16Array(buf)[0].toString(16).padStart(4, '0');
            }
            return String(v);
        }
        if (bits <= 32) {
            const mask = bits === 32 ? 0xffffffff : ((1 << bits) - 1);
            const u = (Number(v) & mask) >>> 0;
            return u.toString(16).padStart(Math.max(1, len), '0');
        }
        let n = typeof v === 'bigint' ? v : BigInt(v);
        if (n < 0n) n = (1n << 64n) + n;
        return n.toString(16).padStart(len, '0');
    }

    // After the user edits one of the two cells, derive the matching
    // value in the other base and write it. Bails on partial input
    // (e.g. "1-" mid-typing) so we don't overwrite with garbage.
    function mirrorEditedSibling(cell) {
        const valCell = cell.closest('.ex-val[data-row][data-lane]');
        if (!valCell) return;
        const rec = recForLiveExample();
        if (!rec || !rec.example) return;
        const ri = +valCell.dataset.row;
        const inp = rec.example.inputs && rec.example.inputs[ri];
        if (!inp) return;
        const ti = laneInfoFor(inp.type, rec.name, 'input');
        if (!ti || !ti.bits) return;
        const dec = valCell.querySelector('.ex-dec');
        const hex = valCell.querySelector('.ex-hexcell');
        if (!dec || !hex) return;
        const isDec = cell.classList.contains('ex-dec');
        try {
            if (isDec) {
                const text = dec.textContent.trim();
                let v;
                if (ti.kind === 'float' || ti.kind === 'bfloat') {
                    v = Number(text);
                    if (Number.isNaN(v) && text.toLowerCase() !== 'nan') return;
                } else {
                    if (!/^[+-]?\d+$/.test(text)) return;
                    v = parseInt(text, 10);
                }
                hex.textContent = _hexFromValueLocal(v, ti.bits, ti.kind);
            } else {
                const text = hex.textContent.trim();
                if (!text) return;
                const v = parseHexLane(text, ti.bits, ti.kind);
                dec.textContent = String(v);
            }
        } catch (_) { /* mid-typing: leave the sibling alone */ }
    }

    // Pull the user's current input values out of the editable cells.
    // Honors hex mode: if the .ex container has class "hex", read from
    // the .ex-hexcell; otherwise read the decimal cell.
    function readLiveInputs(exNode, rec) {
        const inputs = rec.example.inputs;
        const out = inputs.map(inp =>
            new Array(Array.isArray(inp.values) ? inp.values.length : 1));
        const isHexMode = exNode.classList.contains('hex');
        for (const cell of exNode.querySelectorAll('.ex-val[data-row][data-lane]')) {
            const ri = +cell.dataset.row, li = +cell.dataset.lane;
            // Intel vector types (`__m128i`, `__m256i`, ...) carry no lane
            // shape in the type name; lane bits/kind come from the
            // intrinsic suffix. Use laneInfoFor so hex parsing picks up
            // the right width -- otherwise parseHexLane with bits=null
            // masks every hex digit to 0.
            const ti = laneInfoFor(inputs[ri].type, rec.name, 'input');
            const dec = cell.querySelector('.ex-dec');
            const hex = cell.querySelector('.ex-hexcell');
            if (!dec) continue;
            let v;
            if (isHexMode && hex && hex.textContent.trim() !== '') {
                try {
                    v = parseHexLane(hex.textContent.trim(), ti.bits, ti.kind);
                } catch (e) {
                    throw new Error(
                        inputs[ri].name + '[' + li + '] = "' + hex.textContent.trim() + '" is not valid hex');
                }
            } else {
                const text = dec.textContent.trim();
                if (ti.kind === 'float' || ti.kind === 'bfloat') {
                    v = Number(text);
                    if (Number.isNaN(v) && text.toLowerCase() !== 'nan') throw new Error(
                        inputs[ri].name + '[' + li + '] = "' + text + '" is not a number'
                    );
                } else {
                    if (!/^[+-]?\d+$/.test(text)) throw new Error(
                        inputs[ri].name + '[' + li + '] = "' + text + '" is not an integer'
                    );
                    v = parseInt(text, 10);
                }
            }
            // Clamp to the lane's representable range so a stray big
            // number doesn't silently wrap or get rejected by clang.
            if (ti.bits && (ti.kind === 'int' || ti.kind === 'uint'
                || ti.kind === 'poly' || ti.kind === 'mask')) {
                v = clampIntegerLane(v, ti.bits, ti.kind);
            }
            out[ri][li] = v;
        }
        return out;
    }

    function seeOnCE(exNode) {
        const params = new URLSearchParams(location.search);
        const name = params.get('intrinsic');
        const rec = name && records[name];
        if (!rec) return;
        try {
            const inputValues = readLiveInputs(exNode, rec);
            const url = ceClientstateUrl(rec, inputValues);
            if (url) window.open(url, '_blank', 'noopener');
        } catch (err) {
            const status = exNode.parentElement.querySelector('.ex-status');
            if (status) {
                status.textContent = String(err.message || err);
                status.className = 'ex-status is-error';
            }
        }
    }

    async function runOnCE(exNode) {
        // Find the rec via the URL (we're on /?intrinsic=NAME).
        const params = new URLSearchParams(location.search);
        const name = params.get('intrinsic');
        const rec = name && records[name];
        if (!rec) return;
        const status = exNode.parentElement.querySelector('.ex-status');
        if (status) {
            status.textContent = 'compiling on godbolt.org…';
            status.className = 'ex-status is-busy';
        }
        try {
            const inputValues = readLiveInputs(exNode, rec);
            const { bytes } = await ceCompileFold(rec, inputValues);
            const outValues = decodeOutput(rec, bytes);
            // Update the output row in place.
            updateOutputRow(exNode, rec, bytes, outValues);
            if (status) {
                status.textContent = 'verified on Compiler Explorer ✓';
                status.className = 'ex-status is-ok';
            }
        } catch (err) {
            if (status) {
                status.textContent = String(err.message || err);
                status.className = 'ex-status is-error';
            }
        }
    }

    function updateOutputRow(exNode, rec, bytes, outValues) {
        // Compute which output lanes actually changed so the renderer
        // can flag them (.ex-changed). Compare strings to side-step
        // BigInt vs Number coercion quirks.
        const oldValues = (rec.example.output && rec.example.output.values) || [];
        const changedOutputLanes = new Set();
        for (let i = 0; i < outValues.length; i++) {
            if (String(oldValues[i]) !== String(outValues[i])) {
                changedOutputLanes.add(i);
            }
        }

        const newOut = Object.assign({}, rec.example.output, {
            bytes_hex: Array.from(bytes).map(b =>
                b.toString(16).padStart(2, '0')).join(''),
            values: outValues,
        });
        const newExample = Object.assign({}, rec.example, { output: newOut });
        // Persist the user's currently-edited inputs into the rec so
        // re-render shows them (otherwise we'd snap back to cached vals).
        const liveInputs = readLiveInputs(exNode, rec);
        newExample.inputs = rec.example.inputs.map((inp, i) =>
            Object.assign({}, inp, { values: liveInputs[i] })
        );
        rec.example = newExample;
        const wrap = exNode.closest('.ex-wrap');
        // Carry the user's dec/hex preference across the re-render so
        // updating doesn't snap them back to dec.
        const wasHex = exNode.classList.contains('hex');
        const parent = wrap ? wrap.parentNode : exNode.parentNode;
        const lr = liveRunnability(rec);
        _renderExampleViewable = isLiveViewable(rec);
        _renderExampleRunnable = lr.runnable;
        _renderExampleNoRunReason = lr.reason;
        try {
            (wrap || exNode).outerHTML = renderExample(
                newExample, rec.name, { changedOutputLanes }
            );
        } finally {
            _renderExampleViewable = false;
            _renderExampleRunnable = false;
            _renderExampleNoRunReason = null;
        }
        if (wasHex && parent) {
            const newEx = parent.querySelector('.ex-wrap .ex')
                || parent.querySelector('.ex');
            if (newEx) {
                newEx.classList.add('hex');
                for (const b of newEx.querySelectorAll('button.ex-mode')) {
                    const active = b.dataset.mode === 'hex';
                    b.classList.toggle('is-active', active);
                    b.setAttribute('aria-pressed', active ? 'true' : 'false');
                }
            }
        }
    }

    function decodeLaneBytes(bytes, bits, kind) {
        if (kind === 'float') {
            if (bits === 32) return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 4))[0];
            if (bits === 64) return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 8))[0];
            if (bits === 16 && typeof Float16Array !== 'undefined') {
                return new Float16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 2))[0];
            }
        }
        if (kind === 'bfloat' && bits === 16) {
            const buf = new ArrayBuffer(4);
            new Uint8Array(buf).set([0, 0, bytes[0], bytes[1]]);
            return new Float32Array(buf)[0];
        }
        if (bits <= 32) {
            let n = 0;
            for (let i = bytes.length - 1; i >= 0; i--) n = (n * 256) + bytes[i];
            if (kind === 'int' && (bytes[bytes.length - 1] & 0x80)) {
                n -= Math.pow(2, bits);
            }
            return n;
        }
        // 64-bit
        let big = 0n;
        for (let i = bytes.length - 1; i >= 0; i--) big = (big << 8n) | BigInt(bytes[i]);
        if (kind === 'int' && (bytes[bytes.length - 1] & 0x80)) {
            big -= 1n << BigInt(bits);
        }
        return big.toString();  // string for safe display past Number precision
    }
    // Per-render flags set by the dedicated /?intrinsic page. Both default
    // to false in compact-card / tooltip rendering.
    //   _renderExampleViewable -- inputs are editable + "see on CE" button
    //   _renderExampleRunnable -- additionally show "run on CE" button
    let _renderExampleViewable = false;
    let _renderExampleRunnable = false;
    let _renderExampleNoRunReason = null;

    // Lane info that's Intel-aware: for `__m128i` etc., the lane shape
    // comes from the intrinsic-name suffix, not the C type.
    function laneInfoFor(typeName, intrinsicName, context) {
        if (intrinsicName && isIntelIntrinsic(intrinsicName)
            && INTEL_VEC_BYTES[typeName] != null) {
            const info = intelLaneInfoFor(intrinsicName, typeName, context);
            return { bits: info.bits, kind: info.kind };
        }
        return laneInfo(typeName);
    }

    // Reasons we don't have a worked example for a given intrinsic.
    // Order matters -- we return the first match.
    const NO_EXAMPLE_REASONS = [
        // ARM scalable / streaming families: harness doesn't model
        // svbool_t, svintN_t, mve_pred16_t etc. yet.
        { match: r => (r.family || []).some(f =>
            f === 'SVE' || f === 'SVE2' || f === 'SME and SME2' || f === 'Helium'),
          reason: 'Scalable / predicated vector intrinsics ('
              + 'SVE / SVE2 / SME / Helium MVE) — the verifier doesn\'t '
              + 'model the runtime-length vector and predicate types yet. '
              + 'Tracking this as a v1 follow-up.' },
        // Intel SVML transcendentals: clang doesn\'t ship them, only
        // Intel\'s compiler does.
        { match: (r, n) => /^_(?:mm|mm256|mm512)_(?:acos|asin|atan|atan2|cos|sin|sincos|tan|cosh|sinh|tanh|acosh|asinh|atanh|cbrt|cdf|cdfinv|erf|erfc|erfinv|exp|exp10|exp2|expm1|hypot|invcbrt|invsqrt|log|log10|log2|log1p|logb|pow|svml|trunc)/.test(n),
          reason: 'Intel SVML transcendental — clang doesn\'t ship a '
              + 'declaration for this; it lives in Intel\'s closed-source '
              + 'libsvml. We\'d need to either link against libsvml or '
              + 'declare a stub.' },
        // Tile / AMX intrinsics need a special tile config + load/store
        // ceremony we don\'t emit.
        { match: (r, n) => /^_?_tile_/.test(n),
          reason: 'AMX tile intrinsic — needs an explicit `_tile_loadconfig` '
              + 'set-up that the harness doesn\'t emit.' },
        // SM3/SM4 require Apple-Silicon-absent hardware to execute, and
        // clang\'s IR folder doesn\'t model them.
        { match: (r, n) => /^v(?:sm3|sm4)/.test(n),
          reason: 'SM3 / SM4 cryptography — Apple Silicon doesn\'t ship '
              + 'this hardware, so the execute fallback SIGILLs. Would '
              + 'need an aarch64 emulator.' },
        // Scalar Intel ops (popcnt, bextr, lzcnt, tzcnt, ...): not really
        // SIMD, the harness skips them.
        { match: (r, n) => /^_(?:popcnt|lzcnt|tzcnt|bextr|blsi|blsr|blsmsk|pext|pdep|bzhi|andn|mulx)/.test(n),
          reason: 'Scalar bit-manipulation intrinsic, not SIMD. '
              + 'The verifier focuses on vector ops.' },
        // AES / SHA / CLMUL: usually need byte-shuffled inputs to
        // produce non-trivial output; default test vectors are boring.
        { match: (r, n) => /aes|sha\d|sm3|clmul|crc32/i.test(n),
          reason: 'Crypto / hashing intrinsic — needs hand-picked input '
              + 'vectors to produce a meaningful worked example. Open a '
              + 'feature request with a suggested input pair.' },
    ];

    // ARM per-microarch perf table, lazy-loaded from dist/arm-perf.json.
    // The intrinsic page renders an empty `.arm-perf` placeholder; after
    // the card is mounted, we call hydrateArmPerf() to fetch (once),
    // look up the intrinsic's asm form, and inject the table.
    let _armPerfPromise = null;
    function loadArmPerf() {
        if (_armPerfPromise) return _armPerfPromise;
        _armPerfPromise = fetch('dist/arm-perf.json', { credentials: 'omit' })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null);
        return _armPerfPromise;
    }

    async function hydrateArmPerf(root) {
        const slots = root.querySelectorAll('.arm-perf[data-intrinsic]');
        if (!slots.length) return;
        const data = await loadArmPerf();
        for (const slot of slots) {
            const name = slot.dataset.intrinsic;
            slot.innerHTML = renderArmPerfBody(data, name);
        }
    }

    // CE-verify status, lazy-loaded from dist/ce_verify.jsonl. The intrinsic
    // page renders an empty `.ex-verify` placeholder; after mount we fetch
    // (once), build a name→row map, and inject a small badge. A 404 means
    // the verifier hasn't run yet -- treat as "no data, show nothing".
    let _ceVerifyPromise = null;
    function loadCeVerify() {
        if (_ceVerifyPromise) return _ceVerifyPromise;
        _ceVerifyPromise = fetch('dist/ce_verify.jsonl', { credentials: 'omit' })
            .then(r => r.ok ? r.text() : '')
            .then(text => {
                const map = new Map();
                for (const line of (text || '').split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const row = JSON.parse(line);
                        if (row && row.name) map.set(row.name, row);
                    } catch (_) { /* skip */ }
                }
                return map;
            })
            .catch(() => new Map());
        return _ceVerifyPromise;
    }

    function renderCeVerifyBadge(row) {
        if (!row) return '';
        const s = row.status;
        const compiler = row.compiler || 'Compiler Explorer';
        if (s === 'ok') {
            const note = row.notes === 'compile_only' ? ' (compile-only)' : '';
            return `<span class="ex-verify-tag ok">✓ verified on Compiler Explorer</span>`
                + ` <span class="ex-verify-meta">${escapeHtml(compiler)}${note}</span>`;
        }
        if (s && s.startsWith('skipped')) return '';
        const label = ({
            compile_failed:    'harness does not compile on CE',
            run_failed:        'harness compiled but failed to run on CE',
            output_mismatch:   'CE output disagrees with cached bytes',
            output_unparseable:'CE output was not parseable as hex',
            no_result_bytes:   'CE compiled but RESULT was not constant-folded',
            network_error:     'CE could not be reached',
        })[s] || ('verifier status: ' + s);
        const err = row.error_excerpt ? `: <code>${escapeHtml(row.error_excerpt)}</code>` : '';
        return `<span class="ex-verify-tag fail">⚠ ${escapeHtml(label)}</span>${err}`;
    }

    async function hydrateCeVerify(root) {
        const slots = root.querySelectorAll('.ex-verify[data-name]');
        if (!slots.length) return;
        const map = await loadCeVerify();
        for (const slot of slots) {
            const row = map.get(slot.dataset.name);
            const html = renderCeVerifyBadge(row);
            if (html) slot.innerHTML = html;
        }
    }

    // Intel per-microarch perf, lazy-loaded straight from Intel's CDN.
    // The file assigns a `perf2_js` global, keyed by XED operand-form.
    // We don't re-host it -- the <script> tag pulls fresh data each
    // page load (subject to browser cache).
    let _intelPerfPromise = null;
    const INTEL_PERF_URL =
        'https://www.intel.com/content/dam/develop/public/us/en/include/intrinsics-guide/perf2.js';
    function loadIntelPerf() {
        if (_intelPerfPromise) return _intelPerfPromise;
        _intelPerfPromise = new Promise(resolve => {
            if (window.perf2_js) return resolve(window.perf2_js);
            const s = document.createElement('script');
            s.src = INTEL_PERF_URL;
            s.async = true;
            s.onload = () => resolve(window.perf2_js || null);
            s.onerror = () => resolve(null);
            document.head.appendChild(s);
        });
        return _intelPerfPromise;
    }

    async function hydrateIntelPerf(root) {
        const slots = root.querySelectorAll('.intel-perf[data-xed]');
        if (!slots.length) return;
        const perf = await loadIntelPerf();
        for (const slot of slots) {
            const xed = slot.dataset.xed;
            slot.innerHTML = renderIntelPerfBody(perf, xed);
        }
    }

    function renderIntelPerfBody(perf, xed) {
        if (!perf) {
            return '<div class="arm-perf-empty">Intel\'s perf2.js failed to load '
                + '(blocked or offline).</div>';
        }
        const rows = perf[xed];
        if (!rows || !rows.length) {
            return `<div class="arm-perf-empty">No entry for <code>${escapeHtml(xed)}</code> `
                + `in Intel's perf2.js (newer ops -- e.g. AMX tiles -- often unmeasured).</div>`;
        }
        let html = `<div class="arm-perf-form">xed: <code>${escapeHtml(xed)}</code></div>`;
        html += '<table class="arm-perf-table">';
        html += '<thead><tr><th class="arm-perf-mcpu">microarch</th>'
            + '<th title="latency in cycles">lat</th>'
            + '<th title="reciprocal throughput (cycles per instruction; lower is faster)">rT</th>'
            + '</tr></thead><tbody>';
        for (const row of rows) {
            const k = Object.keys(row)[0];
            const v = row[k] || {};
            const lat = v.l || '?';
            const tp = v.t || '?';
            html += `<tr><td class="arm-perf-mcpu">${escapeHtml(k)}</td>`
                + `<td>${escapeHtml(lat)}</td><td>${escapeHtml(tp)}</td></tr>`;
        }
        html += '</tbody></table>';
        html += '<div class="arm-perf-foot">Sourced live from Intel\'s '
            + '<a href="' + INTEL_PERF_URL + '" target="_blank" rel="noopener">perf2.js</a>, '
            + 'the same file the official iguide page fetches.</div>';
        return html;
    }

    function renderArmPerfBody(data, name) {
        const llvmTdUrl = 'https://github.com/llvm/llvm-project/tree/main/llvm/lib/Target/AArch64';
        const llvmLink = `LLVM's <a href="${llvmTdUrl}" target="_blank" rel="noopener">AArch64 scheduling models</a>`;
        if (!data) return '<div class="arm-perf-empty">Perf data not available '
            + '(arm-perf.json missing -- run scripts/build_arm_perf.py).</div>';
        const form = data.intrinsics[name];
        if (!form) {
            return `<div class="arm-perf-empty">Could not find performance `
                + `information in ${llvmLink} for this intrinsic — its asm `
                + `lowering doesn't match a single classifiable form (often a `
                + `multi-instruction or pointer-arg lowering).</div>`;
        }
        const row = data.forms[form];
        const haveAny = row && row.some(r => r);
        if (!haveAny) {
            return `<div class="arm-perf-empty">Could not find performance `
                + `information in ${llvmLink} for <code>${escapeHtml(form)}</code> `
                + `on any tracked microarch.</div>`;
        }
        const cells = [];
        cells.push(`<div class="arm-perf-form">asm: <code>${escapeHtml(form)}</code></div>`);
        let html = '<table class="arm-perf-table">';
        html += '<thead><tr><th class="arm-perf-mcpu">microarch</th>'
            + '<th title="micro-ops">uops</th>'
            + '<th title="latency in cycles">lat</th>'
            + '<th title="reciprocal throughput (cycles per instruction; lower is faster)">rT</th>'
            + '</tr></thead><tbody>';
        for (let i = 0; i < data.microarchs.length; i++) {
            const m = data.microarchs[i];
            const r = row[i];
            if (r) {
                html += `<tr><td class="arm-perf-mcpu">${escapeHtml(m)}</td>`
                    + `<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`;
            } else {
                html += `<tr class="arm-perf-na"><td class="arm-perf-mcpu">${escapeHtml(m)}</td>`
                    + `<td colspan="3">no model</td></tr>`;
            }
        }
        html += '</tbody></table>';
        cells.push(html);
        cells.push(`<div class="arm-perf-foot">Derived from ${llvmLink} `
            + `via <code>llvm-mca&nbsp;--instruction-info</code>.</div>`);
        return cells.join('');
    }

    function renderNoExample(name, rec) {
        for (const { match, reason } of NO_EXAMPLE_REASONS) {
            try {
                if (match(rec, name)) {
                    return `<div class="ex-empty">No worked example. <em>${escapeHtml(reason)}</em></div>`;
                }
            } catch (_) { /* fall through */ }
        }
        return (
            `<div class="ex-empty">No worked example yet. `
            + `<a href="https://github.com/MarcinZukowski/simd.dev/issues/new"`
            + ` target="_blank" rel="noopener">Open an issue</a> with a `
            + `suggested input vector and we\'ll add one.</div>`
        );
    }

    // `highlight` (optional): { changedOutputLanes: Set<number> } -- cells
    // in the output row whose values changed since the last render get
    // an `.ex-changed` class. Used right after a successful "run on CE".
    function renderExample(ex, intrinsicName, highlight) {
        const inputs = ex.inputs || [];
        const out = ex.output || {};
        const outVals = Array.isArray(out.values) ? out.values : [out.values];

        function hexFromValue(v, bits, kind) {
            if (bits == null) return String(v);
            const len = bits / 4;
            if (kind === 'float' || kind === 'bfloat') {
                const f = Number(v);
                if (kind === 'bfloat') {
                    const buf = new ArrayBuffer(4);
                    new Float32Array(buf)[0] = f;
                    const u = new Uint32Array(buf)[0];
                    return ((u >>> 16) & 0xffff).toString(16).padStart(4, '0');
                }
                if (bits === 32) {
                    const buf = new ArrayBuffer(4);
                    new Float32Array(buf)[0] = f;
                    return new Uint32Array(buf)[0].toString(16).padStart(8, '0');
                }
                if (bits === 64) {
                    const buf = new ArrayBuffer(8);
                    new Float64Array(buf)[0] = f;
                    return new BigUint64Array(buf)[0].toString(16).padStart(16, '0');
                }
                if (bits === 16 && typeof Float16Array !== 'undefined') {
                    const buf = new ArrayBuffer(2);
                    new Float16Array(buf)[0] = f;
                    return new Uint16Array(buf)[0].toString(16).padStart(4, '0');
                }
                return String(v);
            }
            if (bits <= 32) {
                const mask = bits === 32 ? 0xffffffff : ((1 << bits) - 1);
                const u = (Number(v) & mask) >>> 0;
                return u.toString(16).padStart(len, '0');
            }
            let n = typeof v === 'bigint' ? v : BigInt(v);
            if (n < 0n) n = (1n << 64n) + n;
            return n.toString(16).padStart(len, '0');
        }
        function hexFromBytes(bytesHex, laneIdx, bits) {
            const lb = bits / 8;
            const slice = bytesHex.slice(laneIdx * lb * 2, (laneIdx + 1) * lb * 2);
            return slice.match(/.{1,2}/g).reverse().join('');
        }

        const rows = [];
        for (let ri = 0; ri < inputs.length; ri++) {
            const inp = inputs[ri];
            const { bits, kind } = laneInfoFor(inp.type, intrinsicName, 'input');
            const vals = Array.isArray(inp.values) ? inp.values : [inp.values];
            // Pointer params (loads) show what the intrinsic *reads from*
            // memory, not the pointer itself -- use *name to make that
            // clear.
            const isPtr = /\*\s*$/.test(inp.type || '');
            const labelName = (isPtr ? '*' : '') + (inp.name || '');
            rows.push({
                label: labelName + ':',
                values: vals,
                hexes: vals.map(v => hexFromValue(v, bits, kind)),
                cls: '',
                tupleCount: tupleCount(inp.type),
                rowIdx: ri,
            });
        }
        {
            const { bits, kind } = laneInfoFor(out.type, intrinsicName, 'output');
            // Mask outputs: per-lane is one bit, so the byte-slice path
            // (lb = bits/8 = 0.125) doesn't apply -- the value is already
            // 0/1 and that's what we want to render.
            const useByteSlice = out.bytes_hex && bits && kind !== 'mask';
            const hexes = outVals.map((v, i) =>
                useByteSlice ? hexFromBytes(out.bytes_hex, i, bits) : hexFromValue(v, bits, kind)
            );
            rows.push({
                label: '→', values: outVals, hexes,
                cls: 'ex-out', isOut: true,
                tupleCount: tupleCount(out.type),
            });
        }

        // Sub-vector boundaries are per-row: only register tuple rows
        // (int8x16x2_t, etc.) get the thicker separator at lane k * count.
        // Memory rows (pointer types) and plain vectors get no boundary.

        const lanes = Math.max(1, ...rows.map(r => r.values.length));
        const cells = [];
        for (const row of rows) {
            const labelClass = row.isOut ? 'ex-lbl ex-arrow' : 'ex-lbl';
            cells.push(`<span class="${labelClass}">${escapeHtml(row.label)}</span>`);
            for (let i = 0; i < lanes; i++) {
                const isBoundary = row.tupleCount > 0
                    && i > 0 && (i % row.tupleCount) === 0;
                const cls = ['ex-val', row.cls, isBoundary ? 'ex-boundary' : '']
                    .filter(Boolean).join(' ');
                if (i < row.values.length) {
                    const dec = String(row.values[i]);
                    const hex = row.hexes[i] || '';
                    // Inputs become contenteditable on the live-edit
                    // page -- BOTH the dec and hex spellings, so the
                    // user can edit in whichever base is showing.
                    // `.ex-cell` is the shared style hook (outline,
                    // padding, focus ring); `.ex-dec` / `.ex-hexcell`
                    // are the per-base hooks for visibility toggle and
                    // mirror-on-edit detection.
                    const editable = _renderExampleViewable && !row.isOut
                        ? ` contenteditable="true" spellcheck="false"`
                        : '';
                    const dataAttrs = _renderExampleViewable && !row.isOut
                        ? ` data-row="${row.rowIdx}" data-lane="${i}"`
                        : '';
                    const changed = row.isOut && highlight
                        && highlight.changedOutputLanes
                        && highlight.changedOutputLanes.has(i)
                        ? ' ex-changed' : '';
                    cells.push(
                        `<span class="${cls}${changed}"${dataAttrs}>` +
                        `<span class="ex-cell ex-dec"${editable}>${escapeHtml(dec)}</span>` +
                        `<span class="ex-cell ex-hexcell"${editable}>${escapeHtml(hex)}</span>` +
                        `<span class="ex-pad"> </span>` +
                        `</span>`
                    );
                } else {
                    cells.push(`<span class="${cls}"></span>`);
                }
            }
        }
        const cols = `auto repeat(${lanes}, max-content)`;
        const toggle =
            `<div class="ex-modes" role="group" aria-label="number base">` +
            `<button type="button" class="ex-mode is-active" data-mode="dec" aria-pressed="true">dec</button>` +
            `<button type="button" class="ex-mode" data-mode="hex" aria-pressed="false">hex</button>` +
            `</div>`;
        const runBtn = _renderExampleRunnable
            ? `<button type="button" class="ex-run" title="Re-compile on Compiler Explorer">↻ update (via CE)</button>`
            : '';
        const seeBtn = _renderExampleViewable
            ? `<button type="button" class="ex-see" title="Open the harness in Compiler Explorer">↗ see on CE</button>`
            : '';
        const status = _renderExampleViewable
            ? `<div class="ex-status" role="status"></div>`
            : '';
        // When the worked example exists but live update doesn't work,
        // surface the reason so users aren't left wondering where the
        // "↻ update" button went.
        const noRunNote = (_renderExampleViewable && !_renderExampleRunnable
                && _renderExampleNoRunReason)
            ? `<div class="ex-norun"><strong>No live update:</strong> `
                + `${escapeHtml(_renderExampleNoRunReason)}</div>`
            : '';
        // CE-verify badge: populated by hydrateCeVerify() from
        // dist/ce_verify.jsonl after the page mounts. Empty until then
        // (or forever, if no row exists for this intrinsic).
        const ceVerify = _renderExampleViewable
            ? `<div class="ex-verify" data-name="${escapeAttr(name)}"></div>`
            : '';
        const hint = _renderExampleViewable
            ? (_renderExampleRunnable
                ? `<div class="ex-hint"><em>input values are editable</em> — change a number and click <strong>↻ update (via CE)</strong> to recompile (or <strong>↗ see on CE</strong> to inspect the harness).</div>`
                : `<div class="ex-hint"><em>input values are editable</em> — click <strong>↗ see on CE</strong> to inspect / recompile the harness.</div>`)
            : '';
        // Wrap so updateOutputRow can replace the entire example block
        // (hint + panel + buttons + status) atomically without leaving
        // stragglers.
        return (
            `<div class="ex-wrap">` + hint +
            `<div class="ex" style="grid-template-columns:${cols}">${toggle}${cells.join('')}</div>` +
            runBtn + seeBtn + status + noRunNote + ceVerify +
            `</div>`
        );
    }
})();
