/**
 * 频控、预算、审计与行为边界。
 *
 * 设计原则：把「不该做的事」写成代码里的硬拦截，而不是只在文档里提醒。
 */
import { FILES, appendLine, nowIso, randInt, readJson, sleep, writeJson, ensureDirs } from './util.mjs';

export const DEFAULT_SETTINGS = {
  throttle: { minDelayMs: 3000, maxDelayMs: 7000 },
  limits: {
    maxCandidatesPerRun: 50,
    maxResumesPerRun: 20,
    maxPagesPerQuery: 5,
  },
  // 默认对简历里的个人信息做掩码；需要明文时显式 --no-mask
  maskPiiByDefault: true,
  // 命中风控后自动停机，等待人工处理
  stopOnRiskControl: true,
};

export class PolicyError extends Error {
  constructor(message, code = 'POLICY_DENIED') {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export function loadSettings() {
  const user = readJson(FILES.settings, {}) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...user,
    throttle: { ...DEFAULT_SETTINGS.throttle, ...(user.throttle || {}) },
    limits: { ...DEFAULT_SETTINGS.limits, ...(user.limits || {}) },
  };
}

/** 明确禁止的操作，直接拒绝，不提供绕过参数 */
const FORBIDDEN = [
  { re: /群发|批量打招呼|bulk.?greet|mass.?message/i, why: '平台规则与反骚扰要求：不提供批量打招呼/群发能力' },
  { re: /验证码|captcha|滑块|geetest|yidun/i, why: '不绕过任何人机校验；遇到校验请人工在浏览器内完成' },
  { re: /代登录|账号密码|password|credential/i, why: '不接收、不存储账号密码；只复用你本机已登录的浏览器会话' },
  { re: /绕过|bypass|破解|逆向|hook.?stoken/i, why: '不破解风控算法；本 skill 走真实浏览器真实会话' },
];

export function assertAllowed(action) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(action)) throw new PolicyError(rule.why, 'FORBIDDEN_ACTION');
  }
}

export function audit(action, detail = {}) {
  ensureDirs();
  appendLine(FILES.audit, { at: nowIso(), action, ...detail });
}

export function throttle(settings = loadSettings()) {
  const { minDelayMs, maxDelayMs } = settings.throttle;
  return sleep(randInt(minDelayMs, maxDelayMs));
}

/** 单日预算：跨进程累计，超限直接拒绝运行，避免长时间高频采集 */
export function consumeBudget(key, amount = 1, cap = Infinity) {
  ensureDirs();
  const today = new Date().toISOString().slice(0, 10);
  const state = readJson(FILES.budget, {}) || {};
  if (state.date !== today) {
    state.date = today;
    state.counts = {};
  }
  state.counts[key] = (state.counts[key] || 0) + amount;
  writeJson(FILES.budget, state);
  if (state.counts[key] > cap) {
    throw new PolicyError(
      `今日 ${key} 已用 ${state.counts[key] - amount} 次，本次请求将超出上限 ${cap}。请明天再跑，或显式调高 config/settings.json 里的 limits。`,
      'BUDGET_EXCEEDED'
    );
  }
  return state.counts[key];
}

export function budgetSnapshot() {
  const state = readJson(FILES.budget, {}) || {};
  const today = new Date().toISOString().slice(0, 10);
  return state.date === today ? state.counts || {} : {};
}

/** 风控特征识别：命中即停机，交由人工处理 */
export function detectRiskControl(payload) {
  if (!payload) return null;
  const code = payload.code ?? payload.status ?? null;
  const msg = String(payload.message || payload.msg || '');
  if (code === 37) return 'code=37 需要安全校验（__zp_stoken__ 挑战）';
  if (/环境存在异常|请完成验证|安全验证|访问过于频繁|操作频繁/.test(msg)) return msg;
  return null;
}

export class RiskControlError extends Error {
  constructor(reason) {
    super(`触发平台风控：${reason}。已停止本次采集。请在打开的浏览器窗口里人工完成校验后重试。`);
    this.name = 'RiskControlError';
  }
}
