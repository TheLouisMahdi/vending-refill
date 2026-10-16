const SLOTS = [
  '11', '13', '15', '17',
  '21', '22', '23', '24', '25', '26', '27', '28',
  '31', '32', '33', '34', '35', '36', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48',
  '51', '52', '53', '54', '55', '56', '57', '58',
  '61', '62', '63', '64', '65', '66', '67', '68'
];
const CONTENTS_URL = 'https://api.github.com/repos/TheLouisMahdi/vending-refill/contents/data/shortages.json';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isQuantity = (value) => Number.isSafeInteger(value) && value >= 0;
const isText = (value, limit) => typeof value === 'string' && value.length <= limit;
const isTimestamp = (value) => value === null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
function validField(key, value) {
  if (SLOTS.includes(key)) return isQuantity(value);
  if (key.startsWith('label:') && SLOTS.includes(key.slice(6))) return isText(value, 120);
  return key === 'notes' && isText(value, 5000);
}
function fieldValue(state, key) {
  return key === 'notes' ? state.notes : key.startsWith('label:') ? state.labels[key.slice(6)] : state.slots[key];
}

function validState(state) {
  return isObject(state) && Object.keys(state).every((key) => ['updatedAt', 'slots', 'labels', 'notes', 'lastRecordedAt', 'lastRefilledAt'].includes(key)) &&
    isTimestamp(state.updatedAt) &&
    (state.lastRecordedAt === undefined || isTimestamp(state.lastRecordedAt)) &&
    (state.lastRefilledAt === undefined || isTimestamp(state.lastRefilledAt)) &&
    isObject(state.slots) && Object.keys(state.slots).length === SLOTS.length &&
    SLOTS.every((slot) => isQuantity(state.slots[slot])) &&
    (state.labels === undefined || (isObject(state.labels) && Object.keys(state.labels).length === SLOTS.length && SLOTS.every((slot) => isText(state.labels[slot], 120)))) &&
    (state.notes === undefined || isText(state.notes, 5000));
}
function validPatch(body) {
  if (!isObject(body) || !Object.keys(body).every((key) => ['changes', 'expected', 'operation'].includes(key)) || !isObject(body.changes) || !isObject(body.expected)) return false;
  if (body.operation !== undefined && !['record', 'refill'].includes(body.operation)) return false;
  const keys = Object.keys(body.changes);
  if (body.operation === 'refill' && (keys.length !== 1 || !SLOTS.includes(keys[0]) || body.changes[keys[0]] !== 0)) return false;
  return keys.length > 0 && keys.length <= SLOTS.length * 2 + 1 && Object.keys(body.expected).length === keys.length &&
    keys.every((key) => Object.hasOwn(body.expected, key) && validField(key, body.changes[key]) && validField(key, body.expected[key]));
}
function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'vending-refill-api',
    'Content-Type': 'application/json'
  };
}
async function githubRead(env) {
  const response = await fetch(`${CONTENTS_URL}?ref=main`, {
    headers: githubHeaders(env.GITHUB_TOKEN), cache: 'no-store', signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('GitHub read failed');
  const file = await response.json();
  if (typeof file.content !== 'string' || typeof file.sha !== 'string' || file.encoding !== 'base64') throw new Error('Invalid file');
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), (char) => char.charCodeAt(0));
  const state = JSON.parse(new TextDecoder().decode(bytes));
  if (!validState(state)) throw new Error('Invalid stored state');
  // Existing quantities stay intact; new fields are added on the next real write.
  state.labels ??= Object.fromEntries(SLOTS.map((slot) => [slot, '']));
  state.notes ??= '';
  state.lastRecordedAt ??= null;
  state.lastRefilledAt ??= null;
  return { state, sha: file.sha };
}
async function authorized(request, key) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length > 1024) return false;
  const encoder = new TextEncoder();
  const hashes = await Promise.all([header.slice(7), key].map((value) => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = new Set([env.ALLOWED_ORIGIN || 'https://thelouismahdi.github.io']);
    // Set only on the local Wrangler command; production has no localhost origins.
    if (env.DEV_ORIGIN) allowed.add(env.DEV_ORIGIN);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin'
    };
    if (origin && allowed.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !allowed.has(origin)) return json({ error: 'Origin not allowed' }, 403);
    const path = new URL(request.url).pathname;
    if (path !== '/state' && path !== '/slots') return json({ error: 'Not found' }, 404);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...headers, 'Access-Control-Allow-Methods': path === '/state' ? 'GET, OPTIONS' : 'PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      } });
    }
    if (!((path === '/state' && request.method === 'GET') || (path === '/slots' && request.method === 'PATCH'))) {
      return json({ error: 'Method not allowed' }, 405);
    }
    if (!env.GITHUB_TOKEN || (path === '/slots' && !env.ACCESS_KEY)) return json({ error: 'API is not configured' }, 503);
    try {
      if (path === '/state') return json((await githubRead(env)).state);
      if (!await authorized(request, env.ACCESS_KEY)) return json({ error: 'Unauthorized' }, 401);
      if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'Expected JSON' }, 415);
      if (Number(request.headers.get('Content-Length')) > 131072) return json({ error: 'Request too large' }, 413);
      const text = await request.text();
      if (text.length > 131072) return json({ error: 'Request too large' }, 413);
      let patch;
      try { patch = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!validPatch(patch)) return json({ error: 'Invalid slot changes' }, 400);
      const keys = Object.keys(patch.changes);
      // Keep older open tabs compatible with the original single-slot refill payload.
      const operation = patch.operation || (keys.length === 1 && SLOTS.includes(keys[0]) && patch.changes[keys[0]] === 0 ? 'refill' : 'record');
      let latest;
      for (let attempt = 0; attempt < 3; attempt++) {
        latest = await githubRead(env);
        const conflicts = keys.filter((key) => fieldValue(latest.state, key) !== patch.expected[key] && fieldValue(latest.state, key) !== patch.changes[key]);
        if (conflicts.length) return json({ error: 'Conflict', conflicts, state: latest.state }, 409);
        const changed = keys.filter((key) => fieldValue(latest.state, key) !== patch.changes[key]);
        if (changed.length === 0) return json(latest.state);
        const updated = { ...latest.state, updatedAt: new Date().toISOString(), slots: { ...latest.state.slots }, labels: { ...latest.state.labels } };
        updated[operation === 'refill' ? 'lastRefilledAt' : 'lastRecordedAt'] = updated.updatedAt;
        for (const key of changed) {
          if (key === 'notes') updated.notes = patch.changes[key];
          else if (key.startsWith('label:')) updated.labels[key.slice(6)] = patch.changes[key];
          else updated.slots[key] = patch.changes[key];
        }
        const bytes = new TextEncoder().encode(JSON.stringify(updated, null, 2) + '\n');
        const content = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
        const response = await fetch(CONTENTS_URL, {
          method: 'PUT', headers: githubHeaders(env.GITHUB_TOKEN), signal: AbortSignal.timeout(12000),
          body: JSON.stringify({
            message: operation === 'refill' ? `Refill vending slot ${keys[0]}` : 'Update vending shortages',
            branch: 'main', sha: latest.sha, content
          })
        });
        if (response.ok) return json(updated);
        if (response.status !== 409 && response.status !== 422) throw new Error('GitHub write failed');
      }
      latest = await githubRead(env);
      return json({ error: 'Conflict', conflicts: keys.filter((key) => fieldValue(latest.state, key) !== patch.expected[key] && fieldValue(latest.state, key) !== patch.changes[key]), state: latest.state }, 409);
    } catch {
      return json({ error: 'Storage unavailable' }, 502);
    }
  }
};
