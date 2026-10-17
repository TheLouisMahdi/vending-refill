import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

// Git commits are the durable operation log. Rebuilding also recovers older saves.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const dateFormat = new Intl.DateTimeFormat('en-US-u-ca-persian', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit'
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
export function iranTime(timestamp) {
  const parts = Object.fromEntries(dateFormat.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}/${parts.month}/${parts.day}`, time: timeFormat.format(new Date(timestamp)) };
}
export function changesBetween(before, after) {
  const changes = [];
  for (const slot of Object.keys(after.slots).sort()) {
    const product = after.labels?.[slot] || '';
    if (before.slots[slot] !== after.slots[slot]) {
      changes.push({ field: 'quantity', slot, product, before: before.slots[slot], after: after.slots[slot] });
    }
    if ((before.labels?.[slot] || '') !== product) {
      changes.push({ field: 'product', slot, product, before: before.labels?.[slot] || '', after: product });
    }
  }
  if ((before.notes || '') !== (after.notes || '')) {
    changes.push({ field: 'notes', slot: '', product: '', before: before.notes || '', after: after.notes || '' });
  }
  return changes;
}
export const headings = ['ردیف ثبت', 'تاریخ شمسی', 'ساعت ایران', 'عملیات', 'شماره', 'محصول', 'مقدار قبلی', 'مقدار جدید', 'تعداد شارژ', 'شناسه ثبت'];
export function rowsFor(events) {
  return events.flatMap((event, index) => event.changes.map((change) => [
    index + 1, event.date, event.time,
    change.field === 'notes' ? 'یادداشت و آمار قهوه' : change.field === 'product' ? 'تغییر نام محصول' : event.operation === 'refill' ? 'شارژ و خروج از انبار' : 'ثبت آمار',
    change.slot, change.product, change.before, change.after,
    event.operation === 'refill' && change.field === 'quantity' ? change.before - change.after : '', event.id.slice(0, 10)
  ]));
}
export function csvCell(value) {
  // Prevent product names/notes from being interpreted as Excel formulas.
  const safe = typeof value === 'string' && (value.startsWith("'") || /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value)) ? `'${value}` : String(value);
  return `"${safe.replaceAll('"', '""')}"`;
}

if (isMain) {
  const commits = git('log', '--first-parent', '--reverse', '--format=%H%x09%s', '--', 'data/shortages.json').split('\n');
  const events = [];
  let previous;
  for (const line of commits) {
    const [id, message] = line.split('\t');
    const state = JSON.parse(git('show', `${id}:data/shortages.json`));
    if (previous && (message === 'Update vending shortages' || /^Refill vending slot \d+$/.test(message))) {
      const changes = changesBetween(previous, state);
      if (changes.length) {
        const at = state.updatedAt || git('show', '-s', '--format=%cI', id);
        events.push({ id, at, ...iranTime(at), operation: message.startsWith('Refill ') ? 'refill' : 'record', changes });
      }
    }
    previous = state;
  }
  mkdirSync('data', { recursive: true });
  writeFileSync('data/history.json', JSON.stringify({
    brand: 'UniCafe دانشگاه زنجان', timeZone: 'Asia/Tehran', calendar: 'persian',
    source: 'https://github.com/TheLouisMahdi/vending-refill/commits/main/data/shortages.json', events
  }, null, 2) + '\n');
  const rows = [headings, ...rowsFor(events)];
  writeFileSync('data/unicafe-history.csv', '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  console.log(`Exported ${events.length} operations (${rows.length - 1} detail rows).`);
}
