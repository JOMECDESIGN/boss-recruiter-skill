# 数据字典

所有记录以 `jsonl` 存储（一行一个 JSON），按主键合并去重，字段缺失即为空字符串或空数组。

## 候选人 candidates

文件：`data/raw/candidates.jsonl` → 导出 `data/clean/candidates.csv`
主键：`candidateKey`（来源 `encryptGeekId`，缺失时退化为 `姓名|公司`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `candidateKey` | string | 候选人主键，去重依据 |
| `name` | string | 姓名（默认输出掩码） |
| `gender` | string | 性别 |
| `age` | string | 年龄描述，如 `28岁` |
| `degree` | string | 最高学历 |
| `experience` | string | 工作年限 |
| `expectPosition` | string | 期望岗位 |
| `expectCity` | string | 期望城市 |
| `expectSalary` | string | 期望薪资原文，如 `25-40K` |
| `currentCompany` | string | 当前/最近公司 |
| `skills` | string[] | 技能标签 |
| `sourcePage` | string | 来源页（recommend / search） |
| `jobId` | string | 关联职位 ID |
| `sourceUrl` | string | 命中的接口路径，便于回溯 |
| `firstSeenAt` | ISO string | 首次出现时间 |
| `lastSeenAt` | ISO string | 最近一次出现时间 |

## 简历 resumes

文件：`data/raw/resumes.jsonl` → 导出 `data/clean/resumes.csv`
主键：`candidateKey`

| 字段 | 类型 | 说明 |
|---|---|---|
| `candidateKey` | string | 候选人主键 |
| `name` / `gender` / `age` / `degree` / `experience` | string | 基本信息（姓名默认掩码） |
| `phone` / `email` / `wechat` | string | 联系方式，**默认掩码**，需 `--no-mask` 才存明文 |
| `expectPosition` / `expectCity` / `expectSalary` | string | 期望 |
| `workExperiences` | object[] | `{company, title, start, end, desc}` |
| `educations` | object[] | `{school, major, degree, start, end}` |
| `projects` | object[] | `{name, role, desc}` |
| `skills` | string[] | 专业技能 |
| `rawText` | string | DOM 兜底模式下的正文（结构化抽取失败时才有） |
| `sourceUrl` | string | 命中的接口或页面地址 |
| `capturedAt` | ISO string | 抓取时间 |

## 职位 jobs

文件：`data/raw/jobs.jsonl` → 导出 `data/clean/jobs.csv`
主键：`jobKey`（来源 `encryptJobId`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `jobKey` | string | 职位主键 |
| `jobName` | string | 职位名称 |
| `status` | string | 招聘状态 |
| `salary` | string | 薪资范围 |
| `city` / `district` | string | 城市 / 区域 |
| `degree` / `experience` | string | 学历与经验要求 |
| `publishedAt` | string | 发布时间描述 |
| `capturedAt` | ISO string | 抓取时间 |

## 统计 stats

文件：`data/clean/stats.json`

```json
{
  "generatedAt": "ISO",
  "totals": { "candidates": 0, "jobs": 0, "resumes": 0 },
  "byCity": [["北京", 12]],
  "byDegree": [["本科", 30]],
  "byExperience": [["5年", 8]],
  "byPosition": [["前端工程师", 6]],
  "topSkills": [["React", 9]],
  "jobStatus": [["招聘中", 5]]
}
```

## 约定

- **时间**：统一 ISO 8601（UTC），展示时按 `Asia/Shanghai` 换算。
- **数组字段**：CSV 导出时用 `|` 连接，避免与逗号分隔冲突。
- **编码**：CSV 带 UTF-8 BOM，Excel 双击直接正常显示中文。
- **合并语义**：同主键再次出现时覆盖非空字段、保留 `firstSeenAt`、刷新 `lastSeenAt`，因此 jsonl 始终是**当前快照**而非流水。
