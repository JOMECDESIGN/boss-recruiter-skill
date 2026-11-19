import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const DIRS = {
  data: path.join(ROOT, 'data'),
  raw: path.join(ROOT, 'data', 'raw'),
  clean: path.join(ROOT, 'data', 'clean'),
  state: path.join(ROOT, 'data', 'state'),
  probe: path.join(ROOT, 'data', 'probe'),
  profile: path.join(ROOT, '.browser-profile'),
  config: path.join(ROOT, 'config'),
};

export const FILES = {
  candidates: path.join(DIRS.raw, 'candidates.jsonl'),
  resumes: path.join(DIRS.raw, 'resumes.jsonl'),
  jobs: path.join(DIRS.raw, 'jobs.jsonl'),
  audit: path.join(ROOT, 'data', 'audit.log'),
  budget: path.join(DIRS.state, 'budget.json'),
  seen: path.join(DIRS.state, 'seen.json'),
  endpoints: path.join(DIRS.config, 'endpoints.json'),
  settings: path.join(DIRS.config, 'settings.json'),
};

export function ensureDirs() {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function appendLine(file, obj) {
  ensureDirs();
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 跳过损坏行，不因一行脏数据中断整个流水线 */
    }
  }
  return out;
}

export const nowIso = () => new Date().toISOString();

export function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 手机号/邮箱掩码，默认输出即脱敏，避免简历个人信息落盘可读 */
export function maskPhone(v) {
  if (!v) return '';
  const s = String(v).replace(/\s|-/g, '');
  return /^\d{11}$/.test(s) ? `${s.slice(0, 3)}****${s.slice(-4)}` : s.replace(/^(\d{3})\d+(\d{2})$/, '$1****$2');
}

export function maskEmail(v) {
  if (!v) return '';
  const [name, domain] = String(v).split('@');
  if (!domain) return String(v);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}***@${domain}`;
}

export function maskName(v) {
  if (!v) return '';
  const s = String(v);
  return s.length <= 1 ? s : s[0] + '*'.repeat(Math.max(1, s.length - 1));
}
