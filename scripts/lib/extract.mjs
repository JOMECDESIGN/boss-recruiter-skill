/**
 * 结构化抽取。
 *
 * 策略：不硬编码接口 URL，而是「深扫捕获到的所有 JSON」，用字段特征识别
 * 候选人列表 / 简历详情。BOSS 前端改版换接口时，抽取器大概率仍然可用。
 * DOM 抽取只作兜底。
 */

const CANDIDATE_KEYS = [
  'encryptGeekId', 'geekId', 'encryptUserId', 'securityId',
  'geekName', 'name', 'nickName',
  'ageDesc', 'age', 'genderDesc', 'gender',
  'degreeName', 'degree', 'eduLevel',
  'experienceName', 'workYearDesc', 'workYear',
  'expectCity', 'expectPositionName', 'expectSalaryDesc',
  'brandName', 'companyName', 'currentCompany',
];

const RESUME_KEYS = [
  'geekDetailInfo', 'geekBaseInfo', 'resumeInfo', 'resumeDetail',
  'workExpList', 'geekWorks', 'projectExperienceList', 'eduExpList', 'geekEdus',
  'professionalSkill', 'skills', 'certificationList',
];

function hitCount(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
  let n = 0;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') n += 1;
  return n;
}

/** 从捕获池里找出「像候选人列表」的数组 */
export function findCandidateArrays(captured) {
  const found = [];
  const walk = (node, url, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      if (node.length && node.every((it) => it && typeof it === 'object')) {
        const avg = node.reduce((s, it) => s + hitCount(it, CANDIDATE_KEYS), 0) / node.length;
        if (avg >= 3) found.push({ url, items: node, score: avg, size: node.length });
      }
      node.forEach((it) => walk(it, url, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], url, depth + 1);
    }
  };
  for (const entry of captured) walk(entry.json, entry.url);
  return found.sort((a, b) => b.score * b.size - a.score * a.size);
}

/** 从捕获池里找出「像简历详情」的对象 */
export function findResumeObject(captured) {
  let best = null;
  const walk = (node, url, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((it) => walk(it, url, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      const score = hitCount(node, RESUME_KEYS);
      if (score >= 2 && (!best || score > best.score)) best = { url, obj: node, score };
      for (const key of Object.keys(node)) walk(node[key], url, depth + 1);
    }
  };
  for (const entry of captured) walk(entry.json, entry.url);
  return best;
}

const pick = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
};

const listify = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : pick(x, ['name', 'tagName', 'label', 'skillName', 'keyword'], ''))).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
  return [];
};

export function mapCandidate(raw, ctx = {}) {
  const key = String(
    pick(raw, ['encryptGeekId', 'encryptUserId', 'geekId', 'securityId', 'id'], '')
  );
  return {
    candidateKey: key,
    name: pick(raw, ['geekName', 'name', 'nickName']),
    gender: pick(raw, ['genderDesc', 'gender']),
    age: pick(raw, ['ageDesc', 'age']),
    degree: pick(raw, ['degreeName', 'degree', 'eduLevel']),
    experience: pick(raw, ['experienceName', 'workYearDesc', 'workYear']),
    expectPosition: pick(raw, ['expectPositionName', 'positionName', 'jobName']),
    expectCity: pick(raw, ['expectCity', 'cityName', 'expectLocationName']),
    expectSalary: pick(raw, ['expectSalaryDesc', 'salaryDesc', 'expectSalary']),
    currentCompany: pick(raw, ['brandName', 'companyName', 'currentCompany']),
    skills: listify(pick(raw, ['skills', 'skillList', 'tags', 'geekTagList'], [])),
    sourcePage: ctx.sourcePage || '',
    sourceUrl: ctx.sourceUrl || '',
    jobId: ctx.jobId || '',
    firstSeenAt: ctx.at || '',
    lastSeenAt: ctx.at || '',
  };
}

export function mapResume(raw, ctx = {}) {
  const base = raw?.geekBaseInfo || raw?.geekDetailInfo || raw?.resumeInfo || raw;
  const works = raw?.workExpList || raw?.geekWorks || base?.workExpList || [];
  const edus = raw?.eduExpList || raw?.geekEdus || base?.eduExpList || [];
  const projects = raw?.projectExperienceList || base?.projectExperienceList || [];

  return {
    candidateKey: String(pick(base, ['encryptGeekId', 'encryptUserId', 'geekId', 'securityId', 'id'], ctx.candidateKey || '')),
    name: pick(base, ['geekName', 'name', 'realName']),
    gender: pick(base, ['genderDesc', 'gender']),
    age: pick(base, ['ageDesc', 'age']),
    degree: pick(base, ['degreeName', 'degree', 'eduLevel']),
    experience: pick(base, ['experienceName', 'workYearDesc', 'workYear']),
    phone: pick(base, ['phone', 'mobile', 'telephone']),
    email: pick(base, ['email', 'mail']),
    wechat: pick(base, ['wechat', 'weChat', 'wxNumber']),
    expectPosition: pick(base, ['expectPositionName', 'positionName']),
    expectCity: pick(base, ['expectCity', 'cityName']),
    expectSalary: pick(base, ['expectSalaryDesc', 'salaryDesc']),
    workExperiences: works.map((w) => ({
      company: pick(w, ['company', 'brandName', 'companyName']),
      title: pick(w, ['positionName', 'position', 'title']),
      start: pick(w, ['startYear', 'startDate', 'startTime']),
      end: pick(w, ['endYear', 'endDate', 'endTime']),
      desc: pick(w, ['workContent', 'description', 'responsibility']),
    })),
    educations: edus.map((e) => ({
      school: pick(e, ['school', 'schoolName']),
      major: pick(e, ['major', 'speciality']),
      degree: pick(e, ['degreeName', 'degree']),
      start: pick(e, ['startYear', 'startDate']),
      end: pick(e, ['endYear', 'endDate']),
    })),
    projects: projects.map((p) => ({
      name: pick(p, ['name', 'projectName']),
      role: pick(p, ['role', 'roleName']),
      desc: pick(p, ['description', 'projectDescription']),
    })),
    skills: listify(pick(raw, ['professionalSkill', 'skills', 'skillList'], base?.skills || [])),
    sourceUrl: ctx.sourceUrl || '',
    capturedAt: ctx.at || '',
    rawRef: ctx.rawRef || '',
  };
}

/** DOM 兜底：把右滑详情面板的可见文本抓下来 */
export async function extractResumeTextFromDom(page) {
  return page.evaluate(() => {
    const candidates = [
      '.resume-detail', '.geek-detail', '.detail-content', '.resume-box',
      '[class*="resume"]', '[class*="detail"]',
    ];
    let el = null;
    let bestLen = 0;
    for (const sel of candidates) {
      for (const node of document.querySelectorAll(sel)) {
        const t = (node.innerText || '').trim();
        if (t.length > bestLen) {
          bestLen = t.length;
          el = node;
        }
      }
    }
    return {
      selector: el ? el.className : '',
      text: (el ? el.innerText : document.body.innerText || '').trim().slice(0, 20000),
    };
  });
}

/** 从捕获池里汇总所有候选人（去重 + 打来源标记） */
export function collectCandidates(captured, ctx = {}) {
  const arrays = findCandidateArrays(captured);
  const byKey = new Map();
  for (const arr of arrays) {
    for (const item of arr.items) {
      const rec = mapCandidate(item, { ...ctx, sourceUrl: arr.url });
      if (!rec.candidateKey && !rec.name) continue;
      const key = rec.candidateKey || `${rec.name}|${rec.currentCompany}`;
      if (!byKey.has(key)) byKey.set(key, rec);
    }
  }
  return [...byKey.values()];
}

const JOB_KEYS = [
  'encryptJobId', 'jobId', 'jobName', 'positionName',
  'jobStatusDesc', 'statusDesc', 'salaryDesc', 'cityName',
  'jobDegree', 'jobExperience', 'publishTimeDesc',
];

/** 从捕获池里找出「像在招职位列表」的数组 */
export function findJobArrays(captured) {
  const found = [];
  const walk = (node, url, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      if (node.length && node.every((it) => it && typeof it === 'object')) {
        const avg = node.reduce((s, it) => s + hitCount(it, JOB_KEYS), 0) / node.length;
        if (avg >= 3) found.push({ url, items: node, score: avg });
      }
      node.forEach((it) => walk(it, url, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], url, depth + 1);
    }
  };
  for (const entry of captured) walk(entry.json, entry.url);
  return found.sort((a, b) => b.score * b.items.length - a.score * a.items.length);
}

export function mapJob(raw, ctx = {}) {
  return {
    jobKey: String(pick(raw, ['encryptJobId', 'jobId', 'id'], '')),
    jobName: pick(raw, ['jobName', 'positionName', 'name']),
    status: pick(raw, ['jobStatusDesc', 'statusDesc', 'status']),
    salary: pick(raw, ['salaryDesc', 'salary']),
    city: pick(raw, ['cityName', 'city', 'locationName']),
    district: pick(raw, ['areaDistrict', 'district']),
    degree: pick(raw, ['jobDegree', 'degreeName']),
    experience: pick(raw, ['jobExperience', 'experienceName']),
    publishedAt: pick(raw, ['publishTimeDesc', 'publishTime', 'createTime']),
    sourceUrl: ctx.sourceUrl || '',
    capturedAt: ctx.at || '',
  };
}

