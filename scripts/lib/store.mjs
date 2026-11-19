/**
 * 落地存储：按主键合并的快照式 jsonl + CSV 导出。
 * 快照式（每次重写）而不是纯追加，是为了让文件保持可读、可直接 diff。
 */
import fs from 'node:fs';
import { ensureDirs, nowIso, readJsonl } from './util.mjs';

export function upsertByKey(file, keyField, records, { now = nowIso() } = {}) {
  const existing = readJsonl(file);
  const map = new Map();
  for (const row of existing) {
    const k = row?.[keyField];
    if (k) map.set(String(k), row);
  }

  let added = 0;
  let updated = 0;
  for (const rec of records) {
    const k = rec?.[keyField];
    if (!k) continue;
    const key = String(k);
    const prev = map.get(key);
    if (prev) {
      map.set(key, {
        ...prev,
        ...rec,
        firstSeenAt: prev.firstSeenAt || rec.firstSeenAt || now,
        lastSeenAt: now,
      });
      updated += 1;
    } else {
      map.set(key, { ...rec, firstSeenAt: rec.firstSeenAt || now, lastSeenAt: now });
      added += 1;
    }
  }

  ensureDirs();
  const rows = [...map.values()].sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { added, updated, total: rows.length };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('|') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(file, rows, columns) {
  ensureDirs();
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  // BOM：让 Excel 正确识别 UTF-8 中文
  fs.writeFileSync(file, '\ufeff' + lines.join('\n') + '\n', 'utf8');
  return { file, rows: rows.length, columns: cols.length };
}
