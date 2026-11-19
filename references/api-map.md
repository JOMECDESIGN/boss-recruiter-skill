# 接口映射手册

BOSS 前端接口会随版本变化，**本仓库不硬编码任何接口路径**。正确做法是先 `probe` 观察，再决定是否固定。

## 1. 用 probe 发现接口

```bash
boss probe --page recommend --seconds 60
```

窗口打开后，请像正常招聘工作一样操作：翻页、切换筛选、点开一个候选人。60 秒后终端会输出：

```
接口                                次数  结构
/wapi/xxx/yyy/list.json             6     [{encryptGeekId,geekName,ageDesc,...}]
/wapi/xxx/zzz/detail.json           2     {geekBaseInfo,workExpList,eduExpList,...}
```

三列含义：

- **接口**：路径 + 截断的 query，忽略域名与随机参数；
- **次数**：本次操作里被调用几次，次数多的通常是列表主接口；
- **结构**：顶层字段形状 `{a,b,c}` 或数组首元素字段 `[a,b,c]`。

原始响应落在 `data/probe/probe-<page>-<stamp>.jsonl`，需要看完整字段时直接翻这个文件。

## 2. 怎么判断哪个是「主接口」

| 目标数据 | 特征 |
|---|---|
| 候选人列表 | 数组元素含 `encryptGeekId` / `geekName` / `ageDesc` / `degreeName` / `expectPositionName` |
| 简历详情 | 对象含 `geekBaseInfo` 或 `workExpList` + `eduExpList` |
| 职位列表 | 数组元素含 `encryptJobId` / `jobName` / `jobStatusDesc` |

这也是 `scripts/lib/extract.mjs` 里 `CANDIDATE_KEYS` / `RESUME_KEYS` / `JOB_KEYS` 的来源 —— 抽取器用的就是这套判据，所以**不改代码也能识别新接口**。

## 3. 是否要固定接口

| 情况 | 建议 |
|---|---|
| 偶尔跑一次 | 不用固定。保持 `apis` 留空，走页面内捕获，最抗改版 |
| 每天跑、要提速 | 固定列表接口，减少列表页渲染等待 |
| 需要历史分页/深翻 | 固定接口后按 `page` 参数循环，注意频控 |

固定方式：把 probe 得到的路径填进 `config/endpoints.json`：

```json
{
  "apis": {
    "candidates": { "url": "/wapi/.../list.json", "method": "POST" },
    "resume": { "url": "/wapi/.../detail.json", "method": "GET" },
    "resumeUrlTemplate": "https://www.zhipin.com/web/boss/.../{id}"
  }
}
```

填了之后，`pageFetch` 会在页面上下文里调用它 —— Cookie、`__zp_stoken__`、指纹都由浏览器带，**不需要自己造签名**。

## 4. 页面入口

`config/endpoints.json` 的 `pages` 段维护页面地址，默认值见该文件。企业端主要入口：

| key | 用途 |
|---|---|
| `login` | 企业端工作台（未登录会跳登录） |
| `recommend` | 推荐牛人 |
| `search` | 牛人搜索（`candidates --job` 走这里） |
| `chat` | 沟通列表 |
| `jobs` | 职位管理 |

地址若随改版失效，用 `boss probe --url "<你现在能打开的地址>"` 重新确认后更新此处即可，不必改代码。

## 5. 已知风险点

- **`code=37`**：服务端下发 `seed` / `name` / `ts` 要求前端算 `__zp_stoken__`。本项目**不实现**该算法，遇到即停机，请人工在浏览器里完成一次正常访问。
- **详情页右滑面板**：候选人详情常以抽屉形式加载，`resume` 命令已做滚动触发；若仍为空，改用 `--url` 直接打开详情页。
- **列表 DOM 虚拟滚动**：`--scroll` 控制滚动屏数，滚太快会漏数据，默认间隔 1.8s。
