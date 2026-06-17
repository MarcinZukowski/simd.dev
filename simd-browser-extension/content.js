// Content script: decides whether to enable tooltips on this page, then
// hands off to the bundled simd-tooltips.js (loaded as the previous entry
// in content_scripts.js so `SimdTooltips` is already on the isolated-world
// window).

(async () => {
  if (typeof SimdTooltips === 'undefined') return;

  // Don't double up if the page is already running simd-tooltips itself.
  // The library injects <style id="simd-tooltip-styles"> synchronously
  // on init(), and content scripts share the DOM with the page even
  // though they don't share JS globals -- so this marker survives the
  // isolated-world boundary. The script-tag fallback also catches pages
  // where the library is loaded but hasn't finished initializing yet by
  // document_idle.
  if (pageAlreadyHasSimdTooltips()) return;

  const settings = await chrome.storage.sync.get({
    enabled: true,
    includeTypes: true,
    excludePatterns: '',
  });

  let active = false;

  async function apply(s) {
    const shouldRun = s.enabled && !urlExcluded(location.href, s.excludePatterns);
    if (!shouldRun) {
      if (active) {
        SimdTooltips.hide();
        // init({names: {names: [], types: []}}) is the smallest teardown:
        // it tears down listeners (init() detaches first) and leaves an
        // empty nameSet so nothing matches if anything sneaks past.
        await SimdTooltips.init({ names: { names: [], types: [] }, data: { records: {} } });
        active = false;
      }
      return;
    }

    const namesUrl = chrome.runtime.getURL('lib/simd-names.json');
    const dataUrl = chrome.runtime.getURL('lib/simd-data.json');

    const opts = { on: 'hover', dataUrl };
    if (s.includeTypes) {
      opts.namesUrl = namesUrl;
    } else {
      // The library has no "skip types" flag; cheapest workaround is to
      // load the names doc here, drop the types list, and pass it inline.
      const resp = await fetch(namesUrl, { credentials: 'omit' });
      const names = await resp.json();
      names.types = [];
      opts.names = names;
    }
    await SimdTooltips.init(opts);
    active = true;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.storage.sync.get({
      enabled: true,
      includeTypes: true,
      excludePatterns: '',
    }).then(apply);
  });

  apply(settings);
})();

function pageAlreadyHasSimdTooltips() {
  if (document.getElementById('simd-tooltip-styles')) return true;
  if (document.querySelector('script[src*="simd-tooltips"]')) return true;
  return false;
}

function urlExcluded(url, patternsText) {
  if (!patternsText) return false;
  for (const line of patternsText.split(/\r?\n/)) {
    const pat = line.trim();
    if (!pat) continue;
    try {
      if (new RegExp(pat).test(url)) return true;
    } catch (_) {
      // Bad regex -- ignore. The options page surfaces this to the user.
    }
  }
  return false;
}
