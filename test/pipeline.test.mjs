import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findCandidateArrays,
  collectCandidates,
  findResumeObject,
  mapResume,
} from '../scripts/lib/extract.mjs';
import { upsertByKey, writeCsv } from '../scripts/lib/store.mjs';
import { assertAllowed, detectRiskControl, PolicyError } from '../scripts/lib/policy.mjs';
import { maskPhone, maskEmail, readJsonl } from '../scripts/lib/util.mjs';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/captured.sample.json', import.meta.url), 'utf8')
);

const captured = [
  { url: '/wapi/zpgeek/recommend/geek/list.json', at: '2026-01-01T00:00:00Z', json: fixture.listResponse },
  { url: '/wapi/zpgeek/resume/detail.json', at: '2026-01-01T00:00:00Z', json: fixture.resumeResponse },
];

test('能从任意 JSON 里识别出候选人列表数组', () => {
  const arrays = findCandidateArrays(captured);
  assert.equal(arrays.length, 1);
  assert.equal(arrays[0].items.length, 2);
  assert.equal(arrays[0].url, '/wapi/zpgeek/recommend/geek/list.json');
});

test('候选人字段归一化', () => {
  const list = collectCandidates(captured, { at: '2026-01-01T00:00:00Z' });
  assert.equal(list.length, 2);
  const a = list.find((x) => x.candidateKey === 'GEEK_A1');
  assert.equal(a.name, '张三');
  assert.equal(a.degree, '本科');
  assert.equal(a.expectCity, '北京');
  assert.equal(a.expectSalary, '25-40K');
  assert.deepEqual(a.skills, ['React', 'TypeScript', 'Node.js']);
});

test('跨接口重复候选人按主键去重', () => {
  const dup = [
    ...captured,
    { url: '/wapi/other/list.json', at: '', json: fixture.listResponse },
  ];
  const list = collectCandidates(dup, { at: '2026-01-01T00:00:00Z' });
  assert.equal(list.length, 2, '同一 encryptGeekId 只应保留一条');
});

test('能识别简历对象并抽取出工作/教育经历', () => {
  const found = findResumeObject(captured);
  assert.ok(found, '应找到简历对象');
  const r = mapResume(found.obj, { at: '2026-01-01T00:00:00Z' });
  assert.equal(r.candidateKey, 'GEEK_A1');
  assert.equal(r.name, '张三');
  assert.equal(r.workExperiences.length, 2);
  assert.equal(r.workExperiences[0].company, '某某科技有限公司');
  assert.equal(r.educations[0].school, '某大学');
  assert.equal(r.skills.length, 4);
});

test('入库按主键合并，保留 firstSeenAt 并累加条目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-test-'));
  const file = path.join(dir, 'candidates.jsonl');

  const first = upsertByKey(file, 'candidateKey', [
    { candidateKey: 'A', name: '张三', firstSeenAt: '2026-01-01T00:00:00Z' },
    { candidateKey: 'B', name: '李四' },
  ]);
  assert.equal(first.added, 2);
  assert.equal(first.total, 2);

  const second = upsertByKey(file, 'candidateKey', [
    { candidateKey: 'A', name: '张三', expectCity: '北京' },
    { candidateKey: 'C', name: '王五' },
  ]);
  assert.equal(second.added, 1);
  assert.equal(second.updated, 1);
  assert.equal(second.total, 3);

  const rows = readJsonl(file);
  const a = rows.find((r) => r.candidateKey === 'A');
  assert.equal(a.firstSeenAt, '2026-01-01T00:00:00Z', '首次出现时间不应被覆盖');
  assert.equal(a.expectCity, '北京', '新字段应合并进来');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CSV 带 BOM 且正确转义逗号、引号与数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-csv-'));
  const file = path.join(dir, 'out.csv');
  writeCsv(file, [{ a: '含,逗号', b: '含"引号', c: ['x', 'y'] }], ['a', 'b', 'c']);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('\ufeff'), '应有 UTF-8 BOM 以便 Excel 识别');
  assert.ok(text.includes('"含,逗号"'));
  assert.ok(text.includes('"含""引号"'));
  assert.ok(text.includes('x|y'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('硬拦截批量群发等违规操作', () => {
  assert.throws(() => assertAllowed('批量群发打招呼'), PolicyError);
  assert.throws(() => assertAllowed('帮我把验证码绕过'), PolicyError);
  assert.doesNotThrow(() => assertAllowed('candidates jobId=123'));
});

test('风控特征识别', () => {
  assert.ok(detectRiskControl({ code: 37 }));
  assert.ok(detectRiskControl({ code: 0, message: '您的环境存在异常' }));
  assert.equal(detectRiskControl({ code: 0, message: 'Success' }), null);
});

test('个人信息掩码', () => {
  assert.equal(maskPhone('13800001234'), '138****1234');
  assert.equal(maskEmail('zhangsan@example.com'), 'zh***@example.com');
});
