# dsh-grokbot — Grokbot 式多模型协作群聊（DSH 插件）

在 DSH 里开一间「群聊」：把几个不同 provider / model 的成员放进同一个房间，发一条任务，
总指挥自动拆解，成员各用自己的模型并行产出，质检员挑错并触发一轮修补，最后由总指挥收敛成
一份可直接使用的交付。成员之间不共享上下文，只共享显式产物。

- Host 半边：`index.js` —— 注册 `/grokbot/api/*`，用 `ctx.llm.stream` 驱动每个成员各自的模型。
- Client 半边：`client.js` —— 左侧栏「群聊协作」入口 + 整页三栏工作台（成员 / 群聊 / 任务板）。
- 数据：`~/.grokbot/rooms/<roomId>.json`（append-only 消息 + 任务板 + 运行记录）。

## 功能

- **多模型房间**：2–6 位成员，每位独立选 provider / model / 角色 / 人设；三种角色
  `captain`（总指挥）、`worker`（执行成员）、`reviewer`（质检员），可多人同角色，也可一人兼多个房间。
- **任意模型，随时增删**：模型下拉来自 DSH 的实时目录；目录里没有的型号直接在「自定义 provider /
  model」里手填（例如新上线的 `gpt-6.1-sol`、`gemini-4-hydrogen`）。成员行右侧「改」可随时换模型、
  换角色、改名字；「×」删除成员；「+ 添加成员」加人。选中过的型号会记住（localStorage），下次预填。
- **任务模式**：`总指挥拆任务 → 成员并行执行 → 质检 →（不过则补一轮修补）→ 总指挥汇总`。
- **讨论模式**：各成员从自己视角短发言，总指挥收敛；开头写 `@成员名` 可以让某一位单独回答。
- **任务板**：每个子任务的负责人、状态、产出、错误一目了然；失败任务可单条「重试」（只重跑该任务，
  不重新规划整个群聊）。
- **预算护栏**：单轮最多 18 次模型调用，单次产出 2000 tokens、汇总 3000 tokens；质检不通过最多补 1 轮。
- **会话操作**：停止、复制群聊（只复制成员）、导出 Markdown / JSON、删除、按名字搜索房间。
- **崩溃恢复**：宿主重启时，磁盘上仍标记为 running 的轮次会恢复为「已中断」，房间不会锁死。

## 安装

本插件是一个 DSH bundle（本地包，不在插件市场）。安装：

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```

替换已装包需要先卸载再装（`replace=true` 会报 `already-installed`）：

```
plugin_manager action=remove_bundle target=@local/dsh-grokbot
plugin_manager action=install_bundle target=<本目录绝对路径>
```

宿主代码在 DSH 进程内，**重装后需要重启 DSH**；仅替换客户端文件则刷新页面即可。
装好后左侧栏出现「群聊协作」图标。

卸载：`plugin_manager action=remove_bundle target=@local/dsh-grokbot`；数据目录 `~/.grokbot` 不会被删。

## 可选模型（provider 显示名对照）

| provider id | 界面显示名 | 说明 |
| --- | --- | --- |
| `deepseek-official` | DeepSeek | DeepSeek-V4.1-Flash、DeepSeek-V4-Pro |
| `moonshotai` | Moonshot（Kimi） | Kimi K2.6 / K2.7 Code / K3 |
| `antigravity` | Antigravity（Gemini 4 / Claude） | Gemini 4 Hydrogen、Gemini 3.8 Flash、Claude Sonnet/Opus、gpt-oss-120b |
| `openai-codex` | ChatGPT 订阅（GPT-6.x） | GPT-6.2 / 6.1 / 6.0 / 5.6 系列，走本机 ChatGPT 订阅额度 |

带 `-vision` 后缀的 provider 是同一模型加了本地读图能力，纯文字协作不必选。
GPT 系列走的是订阅通道，不按 token 出账单，但版本越新通常越吃额度——想省钱可在成员编辑里
把 `gpt-6.2-sol` 换成 `gpt-6.1-terra` 或 `gpt-5.6-sol`。

## 使用

1. 新建群聊：填群名，勾选 2–6 位成员；建议「总指挥 / 执行成员 / 质检员」各一位。
   没有指定总指挥时，第一位成员会被自动提拔；建群提示里会说明哪些成员因为配置不全被跳过。
2. 在输入框发任务；右侧任务板实时更新。运行中可停止，完成后可导出。
3. 换模型：成员行「改」→ 改 provider / model / 角色 / 名称 / 人设；运行中禁用，先停止。

## 安全模型

- **只接受本机同源请求**：所有接口校验 `Origin`；`http://127.0.0.1:<port>` 同源放行，跨站页面
  一律 403（避免任意网页借浏览器调本机接口、烧掉模型额度）。无 Origin 的命令行工具（curl）放行。
- **房间 id 白名单**：`/^[A-Za-z0-9_-]{1,64}$/`，拒绝路径穿越；非法 URL 编码返回 400 而不是 500。
- **上限**：房间名 60 字、成员名 40 字、单条消息 20000 字、每房间 6 位成员、最多 200 个房间、
  请求体 1 MB。
- **删除墓碑**：删除房间时把内存对象标记为 deleted，正在跑的 workflow 不会再把文件写回来。
- **无 HTML 注入**：客户端全部用 React 文本节点渲染模型输出，不使用 `innerHTML`。

## 数据与接口

Host API 前缀 `/grokbot/api`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 版本、数据目录、房间数 |
| GET | `/bootstrap` | 房间列表 + 模型目录 |
| GET | `/models?refresh=1` | 重新读取 DSH 模型目录 |
| POST | `/rooms` | `{name, members:[{name, role, provider, model, persona}]}`，返回 `{room, warnings}` |
| GET / DELETE | `/rooms/:id` | 读取 / 删除房间（GET 支持 `?since=<seq>` 增量） |
| POST | `/rooms/:id/duplicate` | 复制群聊（只复制成员） |
| GET | `/rooms/:id/export` | 导出 Markdown；`?format=json` 导出报告 JSON |
| POST | `/rooms/:id/members` | 添加成员 |
| PUT | `/rooms/:id/members/:mid` | 改成员：`{name?, role?, provider?, model?, persona?}` |
| DELETE | `/rooms/:id/members/:mid` | 删除成员 |
| POST | `/rooms/:id/messages` | `{text, mode:'task'\|'chat', to?}` |
| POST | `/rooms/:id/tasks/:tid/retry` | 重跑单个失败任务 |
| POST | `/rooms/:id/stop` | 停止当前轮次 |

## 开发

```
node --check index.js && node --check client.js
node --test test/engine.test.mjs     # 13 个用例，假 ctx.llm，不消耗模型额度
```

测试通过 `bot.handle(fakeReq, fakeRes)` 走真实路由，覆盖跨站拦截、路径穿越、成员上限、
崩溃恢复、完整任务流与单任务重试。

## 许可

MIT
