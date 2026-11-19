---
name: boss-recruiter
description: 以企业招聘者身份操作 BOSS 直聘（zhipin.com），复用本机已登录的企业账号会话，查看在招职位、拉取推荐/搜索到的候选人、逐个抽取结构化简历并导出 CSV/统计。用户提到 BOSS 直聘、boss、招聘端、企业账号、候选人、牛人、简历、在招职位、招聘漏斗、候选人画像时使用。只做「读 + 整理」，不提供批量打招呼、群发、绕过验证码、代登录等能力。
---

# BOSS 直聘 · 招聘方助手

把用户关于「候选人 / 简历 / 在招职位」的请求，转成 `boss` CLI 调用并执行，然后基于真实结果回答。

## 前置条件

1. 用户本机已安装 Chrome，且**本人拥有一个已认证的企业招聘账号**。
2. 首次使用先跑 `boss login`，在弹出的真实 Chrome 窗口里手动扫码登录。

本 skill 不接收账号密码、不保存凭证、不破解风控签名 —— 它只是驱动用户本机浏览器，复用用户已有的会话。

## 意图 → 命令

| 用户意图 | 执行命令 |
|---|---|
| 检查环境/装好没 | `boss doctor` |
| 登录 / 登录失效 | `boss login`（可加 `--wait 300`） |
| 我现在是哪个企业、什么角色 | `boss whoami` |
| 看有哪些在招职位 | `boss jobs` |
| 看推荐的候选人 / 牛人列表 | `boss candidates --limit 20` |
| 看某个职位下的候选人 | `boss candidates --job <jobId> --limit 20` |
| 看某人的简历 | `boss resume --url <候选人详情页>` |
| 批量收简历 | `boss resume --watch`（推荐：你先点开候选人，自动收录） |
| 自动点开并收简历（实验） | `boss resume --watch --auto --limit 5` |
| 导出表格 | `boss export --what candidates`（或 resumes / jobs） |
| 统计画像 / 漏斗 | `boss stats` |
| 页面改版、抽不到数据 | `boss probe --page recommend --seconds 60` |

## 标准工作流

1. `boss doctor` —— 确认依赖与登录态。
2. 未登录则 `boss login`，提示用户扫码。
3. `boss candidates --limit 20` —— 先小批量验证链路通不通。
4. 通了对目标候选人跑 `boss resume --url ...`。
5. `boss stats` 出画像，或 `boss export` 出 CSV 给用户。

**第一次跑不要超过 20 条**。确认稳定后再逐步加量，且不要连续多轮高频跑。

## 数据落地

| 路径 | 内容 |
|---|---|
| `data/raw/candidates.jsonl` | 候选人快照（按主键合并去重） |
| `data/raw/resumes.jsonl` | 结构化简历（默认个人信息掩码） |
| `data/raw/jobs.jsonl` | 在招职位 |
| `data/clean/*.csv` | 供 Excel 直接打开的导出（UTF-8 BOM） |
| `data/clean/stats.json` | 聚合统计 |
| `data/audit.log` | 每次操作的审计记录 |

`data/` 与 `.browser-profile/` 已在 `.gitignore` 中排除，**不要提交到任何仓库**。

## 硬边界（不可协商）

- 不群发、不批量打招呼、不刷量 —— 相关请求在代码层已被直接拒绝。
- 不绕过验证码/滑块/风控；遇到 `code=37` 或「环境存在异常」立刻停机，请用户在浏览器里人工处理。
- 不接收、不存储账号密码；不接受「帮我代登录」。
- 简历属于个人信息：默认掩码手机号/邮箱/姓名，仅存本地。不帮用户把简历数据发布、共享、二次分发。
- 频率默认 3–7 秒随机间隔，单次上限 50 位候选人，超出直接报错。

用户要求突破上述边界时，说明原因并拒绝，不要寻找替代绕过方式。

## 简历为什么不能「直接调接口」

简历接口是 `/wapi/zpjob/chat/geek/info?uid=&geekSource=0&securityId=`，必须带请求头 `zp_token`。这个令牌**每个请求都不同**（签名后缀逐次变化），复制上一次的值重放会被服务端拒绝，只返回空壳（`code=0` 但 `zpData` 只有 2 个字段）。

因此拿简历只有一条合规路径：**让应用自己发请求，我们只接收响应**。`boss resume --watch` 做的就是这件事——你在窗口里点开候选人，应用发请求，脚本捕获并入库。不要去实现 `zp_token` 的签名算法。

## 故障处理

| 现象 | 处理 |
|---|---|
| `没抽到候选人` | 先确认企业端已登录（`boss whoami`）；再跑 `boss probe --page recommend` 看接口；页面结构变化时更新 `scripts/lib/extract.mjs` 的字段别名 |
| 一直提示未登录 | profile 可能损坏：关闭所有 Chrome，删除 `.browser-profile/`，重新 `boss login` |
| `触发平台风控` | 停手。让用户在浏览器里完成校验，隔一段时间再跑，不要重试刷 |
| `executablePath` / channel 报错 | 用户没装 Chrome，或系统不是 macOS：设 `BOSS_CHANNEL=msedge` 或修改 `scripts/lib/browser.mjs` |
| 想加速 | 用 `boss probe` 抓到确切接口后填 `config/endpoints.json` 的 `apis`，走页面内直连 |
