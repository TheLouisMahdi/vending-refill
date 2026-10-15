'use strict';

// Set this to the deployed Cloudflare Worker URL (no trailing slash).
const API_URL = 'https://vending-refill-api.poimu80.workers.dev';
const SLOT_GROUPS = [
  ['11', '13', '15', '17'],
  ['21', '22', '23', '24', '25', '26', '27', '28'],
  ['31', '32', '33', '34', '35', '36', '37', '38'],
  ['41', '42', '43', '44', '45', '46', '47', '48'],
  ['51', '52', '53', '54', '55', '56', '57', '58'],
  ['61', '62', '63', '64', '65', '66', '67', '68']
];
const SLOTS = SLOT_GROUPS.flat();
const $ = (id) => document.getElementById(id);
const inputs = new Map();
const baseline = {};
const revisions = {};
const dirty = new Set();
const refillItems = new Map();
let state = null;
let writing = false;
let readVersion = 0;
let reading = false;
let readController = null;
let activeTab = 'entry';
let accessKey = '';
try { accessKey = localStorage.getItem('vending-refill-access-key') || ''; } catch { /* Storage can be unavailable. */ }

function status(message) { $('status').textContent = message; }
function normalize(value) {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x660 : 0x6f0)));
}
function quantity(input) {
  const value = normalize(input.value);
  return /^\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
function updateDirty(slot) {
  const input = inputs.get(slot);
  const value = quantity(input);
  input.setCustomValidity(value === null ? 'فقط عدد صحیح نامنفی وارد کنید' : '');
  input.setAttribute('aria-invalid', String(value === null));
  if (value === null || value !== baseline[slot]) dirty.add(slot);
  else dirty.delete(slot);
  $('save').disabled = !state || writing || dirty.size === 0;
}

const fragment = document.createDocumentFragment();
for (const [groupIndex, group] of SLOT_GROUPS.entries()) {
  for (const [index, slot] of group.entries()) {
    const row = document.createElement('div');
    row.className = 'slot-row' + (groupIndex > 0 && index === 0 ? ' group-start' : '');
    const label = document.createElement('label');
    label.htmlFor = `slot-${slot}`;
    label.dir = 'ltr';
    label.textContent = slot;
    const input = document.createElement('input');
    input.id = `slot-${slot}`;
    input.type = 'text';
    input.inputMode = 'numeric';
    input.enterKeyHint = slot === '68' ? 'done' : 'next';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dir = 'ltr';
    input.pattern = '[0-9۰-۹٠-٩]*';
    input.setAttribute('aria-label', `تعداد موردنیاز شماره ${slot}`);
    input.disabled = true;
    revisions[slot] = 0;
    input.addEventListener('input', () => {
      const normalized = normalize(input.value);
      if (input.value !== normalized) input.value = normalized;
      revisions[slot]++;
      updateDirty(slot);
      status('');
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (quantity(input) === null) { input.reportValidity(); return; }
      const next = inputs.get(SLOTS[SLOTS.indexOf(slot) + 1]);
      if (next) {
        next.focus({ preventScroll: true });
        next.select();
        const rect = next.getBoundingClientRect();
        const viewport = window.visualViewport;
        const top = viewport ? viewport.offsetTop : 0;
        const bottom = top + (viewport ? viewport.height : window.innerHeight);
        if (rect.top < top || rect.bottom > bottom) next.scrollIntoView({ block: 'nearest' });
      }
    });
    inputs.set(slot, input);
    row.append(label, input);
    fragment.append(row);
  }
}
$('slot-rows').append(fragment);

function validState(value) {
  return value && value.slots && Object.keys(value.slots).length === SLOTS.length &&
    SLOTS.every((slot) => Number.isSafeInteger(value.slots[slot]) && value.slots[slot] >= 0);
}
function acceptState(latest, completed = null) {
  if (!validState(latest)) throw new Error('Invalid state');
  state = latest;
  for (const slot of SLOTS) {
    const input = inputs.get(slot);
    if (completed && Object.hasOwn(completed, slot)) {
      if (revisions[slot] === completed[slot]) input.value = latest.slots[slot] > 0 ? String(latest.slots[slot]) : '';
      baseline[slot] = latest.slots[slot];
    } else if (!dirty.has(slot)) {
      input.value = latest.slots[slot] > 0 ? String(latest.slots[slot]) : '';
      baseline[slot] = latest.slots[slot];
    }
    input.disabled = false;
    updateDirty(slot);
  }
  renderRefills();
}
function renderRefills() {
  if (!state) return;
  for (const slot of SLOTS) {
    if (state.slots[slot] === 0) {
      refillItems.get(slot)?.remove();
      refillItems.delete(slot);
      continue;
    }
    let item = refillItems.get(slot);
    if (!item) {
      item = document.createElement('article');
      item.className = 'refill-item';
      const heading = document.createElement('h3');
      heading.textContent = `شماره ${slot}`;
      const count = document.createElement('p');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '✓ تأمین و شارژ شد';
      button.addEventListener('click', () => writeChanges({ [slot]: 0 }, { [slot]: state.slots[slot] }));
      item.append(heading, count, button);
      refillItems.set(slot, item);
      const next = SLOTS.slice(SLOTS.indexOf(slot) + 1).find((id) => refillItems.has(id));
      $('refill-list').insertBefore(item, next ? refillItems.get(next) : null);
    }
    item.querySelector('p').textContent = `تعداد موردنیاز: ${state.slots[slot]}`;
    item.querySelector('button').disabled = writing;
  }
  $('empty-refill').hidden = refillItems.size !== 0;
}

async function refresh() {
  if (!API_URL) { status('نشانی API تنظیم نشده است'); return; }
  if (writing || reading) return;
  reading = true;
  const version = ++readVersion;
  const controller = new AbortController();
  readController = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${API_URL}/state`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Read failed');
    const latest = await response.json();
    if (version === readVersion && !writing) {
      const initial = !state;
      acceptState(latest);
      if (initial) status('');
    }
  } catch {
    if (version === readVersion && !writing) status('اتصال برقرار نشد');
  } finally {
    clearTimeout(timeout);
    if (version === readVersion) { reading = false; readController = null; }
  }
}

function requestKey(invalid = false) {
  $('access-help').textContent = invalid ? 'کد دسترسی نادرست است' : 'کد دسترسی را وارد کنید';
  $('access-key').value = '';
  return new Promise((resolve) => {
    const dialog = $('access-dialog');
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true });
    dialog.showModal();
  });
}
$('access-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('access-key').value.trim();
  if (key) $('access-dialog').close(key);
});
$('access-cancel').addEventListener('click', () => $('access-dialog').close(''));
function rememberKey(key) {
  accessKey = key;
  try {
    if (key) localStorage.setItem('vending-refill-access-key', key);
    else localStorage.removeItem('vending-refill-access-key');
  } catch { /* Keep it in memory when browser storage is blocked. */ }
}
async function writeChanges(changes, expected, completed = null) {
  if (writing || !state || Object.keys(changes).length === 0) return;
  writing = true;
  readVersion++;
  readController?.abort();
  readController = null;
  reading = false;
  $('save').disabled = true;
  renderRefills();
  try {
    let key = accessKey || await requestKey();
    while (key) {
      const response = await fetch(`${API_URL}/slots`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ changes, expected }),
        signal: AbortSignal.timeout(30000)
      });
      if (response.status === 401) {
        rememberKey('');
        key = await requestKey(true);
        continue;
      }
      const result = await response.json();
      if (response.status === 409 && validState(result.state)) {
        acceptState(result.state);
        // A further Save is an explicit retry against the newly displayed conflict.
        for (const slot of Object.keys(changes)) {
          baseline[slot] = result.state.slots[slot];
          updateDirty(slot);
        }
        status('این شماره هم‌زمان تغییر کرده است. ' + (result.conflicts || []).join('، ') + (completed ? ' — برای ثبت دوباره، ذخیره را بزنید.' : ''));
        return;
      }
      if (!response.ok) { status('خطا در ذخیره اطلاعات'); return; }
      acceptState(result, completed);
      rememberKey(key);
      status('ذخیره شد');
      return;
    }
  } catch (error) {
    status(error instanceof TypeError || error.name === 'TimeoutError' ? 'اتصال برقرار نشد' : 'خطا در ذخیره اطلاعات');
  } finally {
    writing = false;
    readVersion++;
    $('save').disabled = !state || dirty.size === 0;
    renderRefills();
    // The write response is authoritative; also synchronize after every attempt.
    void refresh();
  }
}
$('shortage-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (writing || !state || dirty.size === 0) return;
  const changes = {}, expected = {}, completed = {};
  for (const slot of dirty) {
    const input = inputs.get(slot);
    const value = quantity(input);
    if (value === null) { input.focus(); input.reportValidity(); return; }
    changes[slot] = value;
    expected[slot] = baseline[slot];
    completed[slot] = revisions[slot];
  }
  void writeChanges(changes, expected, completed);
});
function showTab(tab) {
  activeTab = tab;
  for (const name of ['entry', 'refill']) {
    const active = name === tab;
    $(`${name}-tab`).setAttribute('aria-selected', String(active));
    $(`${name}-tab`).tabIndex = active ? 0 : -1;
    $(`${name}-panel`).hidden = !active;
  }
  if (tab === 'refill') void refresh();
}
for (const name of ['entry', 'refill']) {
  $(`${name}-tab`).addEventListener('click', () => showTab(name));
  $(`${name}-tab`).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'entry' : event.key === 'End' ? 'refill' : name === 'entry' ? 'refill' : 'entry';
    showTab(next);
    $(`${next}-tab`).focus();
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('online', () => void refresh());
setInterval(() => { if (!document.hidden && (activeTab === 'refill' || !state)) void refresh(); }, 30000);
void refresh();
