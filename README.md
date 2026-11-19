# boss-recruiter-skill

以**企业招聘者身份**操作 BOSS 直聘的 Agent Skill：驱动你本机的真实 Chrome，复用你已登录的企业账号会话，把「在招职位 / 候选人 / 简历」变成本地结构化数据。

不逆向加密、不代理登录、不绕过验证码。

```
真实 Chrome（你已登录的会话）
        │  复用 Cookie + 浏览器指纹
        ▼
   页面内捕获 JSON 响应  ──►  字段归一化  ──►  jsonl / csv / stats
        │
        └── 风控挑战由浏览器自然完成（code=37 时停机等人工）
```

## 为什么这样做

BOSS 的风控是一整套组合：动态 `__zp_stoken__`、设备指纹、极验 + 易盾、前端反调试。业界的两种做法都不理想：

- **纯 HTTP + 逆向签名**：JS 每天变，维护成本极高，且属于破解。
- **无头浏览器硬爬**：无头环境的 Canvas/WebGL 指纹与真人差异明显，token 对了也会被拒。

本项目走第三条路：**用你本人的浏览器、本人的会话**，只在页面上下文里读数据。签名和指纹由浏览器自己产生，我们只负责把结构化结果取出来。

## 安装

```bash
git clone <this-repo> && cd boss-recruiter-skill
npm install
npm link          # 之后可直接用 boss 命令；或用 node scripts/boss.mjs
boss doctor
```

要求：Node ≥ 20，本机已装 Chrome（macOS / Windows / Linux 均可，非 Chrome 可设 `BOSS_CHANNEL=msedge`）。

## 快速开始

```bash
boss login                                   # 扫码登录企业账号，会话长期复用
boss whoami                                  # 确认企业与身份
boss probe --page recommend --seconds 60     # 手动操作一遍，记录真实接口
boss candidates --limit 20                   # 拉推荐候选人
boss resume --url "<候选人详情页地址>"         # 抽结构化简历
boss stats                                   # 画像统计
boss export --what candidates                # 导出 CSV
```

## 命令

| 命令 | 作用 |
|---|---|
| `boss doctor` | 环境自检 |
| `boss login` | 打开企业端等待扫码，保存会话到 `.browser-profile/` |
| `boss whoami` | 显示当前企业名 / 角色 / 登录态 |
| `boss probe` | 监听并记录所有 JSON 接口，输出「接口 → 结构」清单 |
| `boss jobs` | 在招职位列表 |
| `boss candidates` | 候选人列表（推荐牛人 / 按职位） |
| `boss resume` | 单个候选人结构化简历 |
| `boss export` | 导出 CSV（UTF-8 BOM，Excel 直接打开） |
| `boss stats` | 城市 / 学历 / 经验 / 岗位 / 技能聚合 |

常用选项：`--limit` `--scroll` `--job` `--url` `--candidate` `--seconds` `--no-mask`。

## 设计要点

**1. 不硬编码接口**
捕获器监听 context 上所有 `application/json` 响应，抽取器按字段特征识别「这是候选人列表 / 这是简历」。接口改名、版本迭代都不影响主流程。想提速再用 `probe` 抓到的确切路径填进 `config/endpoints.json`。

**2. 抓不到就退回 DOM**
简历详情拿不到 JSON 时，自动退回可见文本抽取，保证不空手而归。

**3. 边界写在代码里**
`scripts/lib/policy.mjs` 里有硬拦截：批量群发、绕验证码、代登录类请求直接抛 `PolicyError`；单日预算、单次上限、随机间隔都是强制项，不是注释。

**4. 个人信息默认掩码**
`138****1234` / `zh***@example.com`，需要明文要显式 `--no-mask`，并自行承担保管责任。

## 目录

```
SKILL.md                 # Agent 技能定义（意图 → 命令映射、工作流、边界）
scripts/boss.mjs         # CLI 入口
scripts/lib/browser.mjs  # Chrome + 持久化 profile
scripts/lib/net.mjs      # 响应捕获 + 页面内 fetch
scripts/lib/extract.mjs  # 字段归一化（候选人/简历/职位）
scripts/lib/store.mjs    # 按主键合并 + CSV
scripts/lib/policy.mjs   # 频控、预算、审计、硬边界
config/                  # 页面地址、接口映射、频控参数
references/              # 接口映射方法、数据字典、合规说明
test/                    # 离线单测 + 真实浏览器集成测试
```

## 测试

```bash
npm test
```

10 项：抽取器字段归一化、跨接口去重、快照合并、CSV 转义、策略拦截、风控识别、PII 掩码，外加一项**真实 Chrome 集成测试**（本地 HTTP 服务模拟接口，验证「启动浏览器 → 捕获响应 → 抽取」整条链）。测试不访问 BOSS 任何真实页面。

## 合规声明

本项目仅用于**你本人**在**你本人账号**下整理招聘工作数据。使用前请确认：

- 遵守 BOSS 直聘用户协议，不做批量采集与二次分发；
- 遵守《个人信息保护法》：简历属个人信息，仅用于招聘评估，控制留存期，不公开、不买卖；
- 不做大规模抓取 —— 默认频控与上限即为保护措施，不建议调高；
- 因使用产生的账号风险与法律责任由使用者自行承担。

若你不具备企业招聘账号，或用途涉及批量采集转售，请不要使用本项目。

## License

MIT
