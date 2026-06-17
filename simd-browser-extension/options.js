const DEFAULTS = {
  enabled: true,
  includeTypes: true,
  excludePatterns: '',
};

const $enabled = document.getElementById('enabled');
const $includeTypes = document.getElementById('includeTypes');
const $patterns = document.getElementById('excludePatterns');
const $save = document.getElementById('save');
const $status = document.getElementById('status');
const $errors = document.getElementById('regex-errors');

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $enabled.checked = s.enabled;
  $includeTypes.checked = s.includeTypes;
  $patterns.value = s.excludePatterns;
});

$save.addEventListener('click', async () => {
  const text = $patterns.value;
  const bad = [];
  for (const line of text.split(/\r?\n/)) {
    const pat = line.trim();
    if (!pat) continue;
    try {
      new RegExp(pat);
    } catch (e) {
      bad.push(`/${pat}/  -- ${e.message}`);
    }
  }
  if (bad.length) {
    $errors.textContent = 'Invalid regex(es) (kept anyway, but they will be ignored at runtime):\n' + bad.join('\n');
    $errors.hidden = false;
  } else {
    $errors.hidden = true;
  }

  await chrome.storage.sync.set({
    enabled: $enabled.checked,
    includeTypes: $includeTypes.checked,
    excludePatterns: text,
  });

  $status.textContent = 'Saved.';
  setTimeout(() => { $status.textContent = ''; }, 1500);
});
