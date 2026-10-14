# 产物中心 · Artifact Center

> DeepSeek Harness（DSH / Cordis）插件：**agent 每次产出重要文件都会登记进一个跨会话的产物中心**，
> 左侧边栏提供面板，按分类 / 后缀 / 关键词即时筛选。

每个对话都在产出文件——报告 PDF、Excel 数据表、PPT、脚本、JSON——但它们散落在各会话的工作目录里，换个对话就找不到了。
本插件把「值得留下的产物」集中到一处：

- **agent 侧**：4 个工具。产出文件时调用 `artifact_save` 登记，默认**复制一份**到统一目录，原目录被清理也不丢。
- **用户侧**：左侧边栏「产物中心」面板。分类 chip + 后缀 chip + 关键词搜索，可复制路径、在文件夹中显示、删除。
- **跨会话**：索引与副本都在 `~/.dsh/artifact-center/`，所有对话共用同一份。

```
┌ 左侧边栏 ────────┐
│ 对话             │
│ 自动化任务       │
│ 产物中心   ← 面板行 │──┐
│ 插件管理         │  │
└──────────────────┘  │
                      ▼
┌ 产物中心 ───────────────────────────────────────┐
│ 分类  [全部] [pdf 3] [excel 2] [code 5] …     刷新│
│ 后缀  [.pdf 3] [.xlsx 2] [.py 4] [.json 1]      │
│ 搜索标题 / 文件名 / 路径 / 备注 / 标签            │
│ ─────────────────────────────────────────────── │
│ 季度报告.pdf      PDF  2.0 MB  复制路径 显示 删除 │
│ train.py          代码 4.1 KB  …                │
└─────────────────────────────────────────────────┘
```

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile desktop add github:lishuo4096/artifact-center

# 本地开发：link 到源码目录
dsh plugin --profile desktop add link:/path/to/artifact-center
```

也可以在插件市场（dshmarket）里搜索 `artifact-center` 一键安装。

装完**重启 DSH**（宿主的插件模块走 ESM 缓存，改完源码或新装插件都需要重启才加载新代码）；
重启后左侧边栏出现「产物中心」，对 agent 说话时 `artifact_save` 等工具即可用。

## agent 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `artifact_save` | `path`（必填）、`title`、`note`、`tags[]`、`mode`（`copy` 默认 / `link`） | 登记一个产物。`copy` 会把文件复制进统一目录；`link` 只记路径不动文件 |
| `artifact_list` | `ext`、`category`、`keyword` | 列出/筛选产物，三个过滤条件可组合 |
| `artifact_stats` | — | 按分类、按后缀的计数 |
| `artifact_remove` | `id`（必填） | 删除条目。`copy` 产物连副本一起删；`link` 产物只删条目，**永不碰原文件** |

工具的返回值是结构化 JSON；`artifact_save` 的 `path` 不存在或不是文件时返回 `{ok:false,message}`，不会抛异常打断对话。

## 面板

左侧边栏「产物中心」，与工具读写同一份索引：

- **分类 chip**：`pdf` / `excel` / `ppt` / `word` / `image` / `code` / `data` / `archive` / `other`，带计数，计数为 0 且未选中的不显示。
- **后缀 chip**：按真实后缀分组（`.pdf`、`.py`、`.json`…），按数量降序。
- **搜索框**：服务端匹配标题、文件名、路径、备注、标签（输入 220ms 防抖）。
- **每行操作**：复制路径 · 在文件夹中显示（Windows `explorer /select`、macOS `open`、Linux `xdg-open`）· 删除（二次确认）。

## 数据与配置

```
~/.dsh/artifact-center/
├── index.json   # 索引：id / 原标题 / 原路径 / 存储路径 / mode / 分类 / 后缀 / 大小 / 备注 / 标签 / 所属会话 / 时间
└── files/       # copy 模式的副本
```

索引写入是串行队列（不会两个 tool 调用互相覆盖）。默认根目录是 `~/.dsh/artifact-center`，
可用插件配置 `rootDir` 覆盖：

```yaml
# cordis.patch.yml（用户覆盖层）
- id: artifact-center
  config:
    rootDir: D:/artifacts
```

## HTTP 路由（面板的数据通道）

面板通过宿主 `webServer` 的同源路由取数据，不需要额外服务：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/artifact-center/api/state` | GET | `?ext=&category=&keyword=` → `{ok, items, stats, rootDir, categories}` |
| `/artifact-center/api/remove` | POST | `{id}` → 删除条目 |
| `/artifact-center/api/reveal` | POST | `{id}` → 在文件管理器里定位；只接受索引里的 id，路径由服务端解析 |

三条路由都带**同源栅栏**：带跨站 `Origin` 的请求直接 403；写操作必须 `content-type: application/json`
（跨站表单这类「简单请求」不触发预检，声明 JSON 则会预检，而预检打到本路由必然 405/415）；
非浏览器调用（curl / node，没有 Origin）照常可用。`reveal` 不接受任意路径参数，所以无法被用来打开任意文件。

没有 `webServer` 的形态（纯 CLI）下，面板这段不激活，4 个工具照常工作。

## 目录结构

```
artifact-center/
├── package.json          # dsh.bundle.patch + dsh.client（web）
├── cordis.patch.yml      # 注册进 profile 的 patch 行
├── index.js              # 宿主半边：4 个工具 + 3 条同源路由
├── client.js             # 浏览器半边：侧边栏面板行 + 面板页（window.__ModuleLoader__ 形态）
├── lib/
│   ├── defineTool.js     # 作者侧工具 DSL → 宿主 JSON Schema（零依赖，必须带）
│   └── store.js          # 索引与副本的存储层（串行写、分类规则）
└── test/
    └── local-smoke.mjs   # 离线自检：81 项断言，不需要 DSH 就能跑
```

`lib/defineTool.js` 不是可选的装饰：宿主真正加载的是 `@deepseek-ai/dsh-tools` 的 `defineTool`，
但在 profile 里以 `link:` 安装的插件**不能 import 任何 `@deepseek-ai/*`**（它们只在 app.asar 内，Node 解析不到），
所以插件必须自带一份等价实现。作者的 `parameters` 用 `required: true` 这种 DSL 写法，`output.schema: {type:'json'}` 表示无约束 JSON。

## 开发与自检

```sh
node test/local-smoke.mjs
```

零依赖，不需要启动 DSH：伪造 `ctx` / `req` / `res` 后覆盖工具行为（复制落盘、link 不复制、删除 link 不动原文件、
筛选与统计）、三条路由（含同源/方法/content-type 栅栏）、`client.js` 的装载与渲染（用 stub React 渲染空态、
有数据、筛选无命中、错误态），以及**工具 schema 必须通过宿主 `assertSupportedJsonSchema`** 这条回归护栏
（作者侧 `type:'json'` 若被原样透传，宿主 `register()` 会同步抛错，进而中断整个 `apply()`——本插件踩过这个坑）。

## 兼容性

- 面板需要 Web GUI（宿主 `webServer` 同源路由 + `sidebar.panellist` / `main` 插槽）。
- 纯 CLI 形态下工具可用，面板不显示。
- 已在本机 DSH 桌面版（Electron，Web GUI `http://127.0.0.1:19387`）上实测：面板渲染、筛选、删除、
  在文件夹中显示，以及 4 个工具均正常。

## License

MIT

---

# Artifact Center (English)

A DeepSeek Harness (DSH / Cordis) plugin that gives every conversation a **shared artifact center**.

Agents produce files all the time — reports, spreadsheets, slides, scripts, JSON — and they end up scattered across
per-session working directories, effectively lost the moment the conversation changes. This plugin registers the
artifacts worth keeping, in one place:

- **Agent tools** — `artifact_save` (copies the file into a shared directory by default, or just records the path with
  `mode:"link"`), `artifact_list` (filter by `ext` / `category` / `keyword`), `artifact_stats`, `artifact_remove`.
- **Sidebar panel** — category chips with counts, extension chips with counts, keyword search, copy path,
  reveal in file manager, delete with confirmation.
- **Cross-session** — index and copies live in `~/.dsh/artifact-center/`, shared by every conversation.

```sh
dsh plugin --profile desktop add github:lishuo4096/artifact-center
```

Restart DSH afterwards. The panel talks to the host over three same-origin routes under `/artifact-center/api/`
(`state`, `remove`, `reveal`); cross-origin requests are rejected, writes require `application/json`, and `reveal`
resolves paths server-side from the index so it cannot be used to open arbitrary files.

Run `node test/local-smoke.mjs` for the dependency-free self-check (81 assertions covering the tools, the routes,
the browser bundle and the tool-schema contract).

MIT licensed.
