# metrics-monitor — AI Coding 能效管理平台

为 AI 编码工具(pizza / Claude Code / OpenCode / Codex / Gemini CLI …)提供统一能效度量:
**活跃用户数、Token 消耗量、成本、编辑采纳率**等指标,**推拉双模**接入,零运行时依赖。

- **云端平台**(`pizza-metrics serve`):单进程 HTTP 服务,内置 Web dashboard、KPI API、
  Prometheus `/metrics`、agent 推送接收端、原生 OTLP/JSON 接收端。SQLite 存储。
- **端侧插件**:
  - pizza 进程内扩展(实时,订阅 pizza 事件流);
  - 独立 agent(`pizza-metrics agent`,轮询各工具本地数据,支持推送与本地 `/metrics` 拉取)。

```
                    ┌─────────────────────────── 推 (push) ───────────────────────────┐
 pizza 事件流(扩展)──┐                                                                 │
 pizza events.sqlite ─┤                                                                 │
 ~/.claude JSONL      ├─→ 端侧 agent ──POST /api/v1/metrics──→ ┌──────────────────────┐ │
 opencode.db          │   (缓冲/重试/断点续传)                  │  云端 server :9480   │ │
 ~/.codex rollouts ───┘                                        │  · SQLite 存储       │ │
                                                               │  · KPI 计算          │ │
 Claude Code / Gemini CLI ──OTLP/JSON POST /v1/metrics ──────→ │  · 内置 dashboard    │ │
 (原生 OTLP,直推或经 agent 中继)                              │  · /metrics          │ │
                                                               └──────────┬───────────┘ │
                    └─────────────────────────── 拉 (pull) ────────────────┼─────────────┘
                                                                           ▼
                    Prometheus 抓取(云端 /metrics 或各 agent :9465 /metrics)→ Grafana
```

## 快速开始

```bash
cd metrics-monitor
npm install && npm run build

# 1. 启动云端平台
node dist/cli.js serve                 # http://127.0.0.1:9480/
node dist/cli.js seed                  # 可选:灌入演示数据看效果

# 2. 查看本机可采集的数据源
node dist/cli.js probe

# 3. 启动端侧 agent(采集本机 pizza / Claude Code / OpenCode / Codex 数据并推送)
node dist/cli.js agent --server http://127.0.0.1:9480
```

打开 <http://127.0.0.1:9480/> 即可看到 dashboard(建议先用 `seed` 灌入两周演示数据)。

## 指标口径(对齐业界标准)

| 指标 | 定义 | 参考 |
|---|---|---|
| 活跃用户数 | 窗口内(日/周/月)有任何活动的去重用户(DAU/WAU/MAU) | GitHub Copilot usage metrics |
| Token 消耗量 | input / output / cache_read / cache_write / reasoning 分型累计 | Claude Code `token.usage` |
| 成本 | 来源自带成本(pizza 由模型单价计算;Claude Code `cost.usage`),缺省时以 token 为主口径 | — |
| 编辑采纳率 | 接受次数 ÷(接受 + 拒绝),仅统计文件编辑类工具决策 | Copilot "suggestions accepted %" |
| 工具调用 / 错误率 | `tool_calls`(含 is_error 维度) | — |
| AI 代码行数 | 编辑 diff 的 added / removed 行数 | Claude Code `lines_of_code.count` |

Prometheus 指标(`agent_*` 前缀,标签:`tool` / `user` / `project` / `model` / …):

```
agent_sessions_total            agent_edit_decisions_total{decision=accept|reject}
agent_requests_total            agent_lines_of_code_total{type=added|removed}
agent_tokens_total{type=…}      agent_active_time_seconds_total
agent_cost_usd_total            agent_active_users{window=daily|weekly|monthly}  (server 计算的 gauge)
agent_tool_calls_total{tool_name,is_error}
```

## 推拉双模

**推(push)**
- 端侧 agent → `POST /api/v1/metrics`(增量批量,失败缓冲、断点续传、服务端幂等去重)
- Claude Code / Gemini CLI / Codex 等 **原生 OTLP/JSON** → `POST /v1/metrics`(服务端自动把
  累计计数器转增量;`claude_code.*`、`codex.*`、`gemini_cli.*` 自动归一化,未识别指标以
  `agent_ext_*` 透传)
- 也可把 OTLP 先推给本机 agent(`http://127.0.0.1:9465/v1/metrics`)再由 agent 中继上云

**拉(pull)**
- Prometheus 抓云端 `http://<server>:9480/metrics`(全量累计 + `agent_active_users` 等 KPI gauge)
- Prometheus 抓各开发机 agent `http://<dev>:9465/metrics`(本机累计)
- agent 轮询本地数据源本质也是一种"拉"采集

### 接入各开发工具

**pizza(进程内扩展,实时)** — `~/.pizza/agent/settings.json`:

```json
{ "extensions": ["<绝对路径>/metrics-monitor/src/adapters/pizza-live.ts"] }
```

扩展直接订阅 pizza 事件流(`AGENT_MESSAGE_END` 的 usage/cost、`INTENT_TOOL_CALL` +
`USER_APPROVAL/USER_REJECTION` 的采纳决策、`FILE_MUTATION_APPLIED` 的代码行数),
配置复用下文环境变量。不装扩展时,agent 会离线尾随 `~/.pizza/agent/workspaces/*/events.sqlite`,
数据相同,且能回补历史。

**Claude Code(原生 OTel 推送,推荐)** — 环境变量:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://<server>:9480/v1/metrics
# 团队身份建议显式标注(否则用匿名 user.id):
export OTEL_RESOURCE_ATTRIBUTES="enduser.id=zhang.san@corp.com"
```

采纳率来自官方指标 `claude_code.code_edit_tool.decision`(兼容旧名
`claude_code.code_edit_tool_decision`);token/成本/会话等同步接入。
**离线兜底**:不配 OTel 时,agent 直接解析 `~/.claude/projects/**/*.jsonl`
(token/请求/工具调用/会话;transcript 是内部格式,采纳率不做离线还原)。

**OpenCode** — 无原生 OTel;agent 解析 `opencode.db`(v1.14+ SQLite)或旧版
`storage/message/**` JSON(`OPENCODE_DATA_DIR` 可覆盖路径)。装社区插件
[DEVtheOPS/opencode-plugin-otel](https://github.com/DEVtheOPS/opencode-plugin-otel)
可输出与 Claude Code 同名指标,同样直推本平台。

**Codex CLI** — agent 解析 `~/.codex/sessions/**/*.jsonl` 的 `token_count` 快照
(token 消耗);配置其 `[otel]` 导出后,`codex.*` 指标也可直推本平台。

**Gemini CLI** — 原生 OTel(`settings.json` 开启 telemetry),OTLP/JSON 直推本平台;
`gemini_cli.*` 自动归一化。

## 配置

配置文件查找:`./metrics-monitor.config.json` → `~/.pizza/metrics-monitor.json`;
环境变量优先级更高(`PIZZA_METRICS_*`)。

```jsonc
// metrics-monitor.config.json
{
  "user": "zhang.san@corp.com",            // 团队身份(默认 OS 用户名@主机名)
  "serverUrl": "http://metrics.internal:9480",
  "apiKey": "shared-secret",
  "intervalSec": 30,
  "pullPort": 9465,
  "tags": { "team": "platform" },          // 附加到所有样本的静态标签
  "adapters": { "pizza": true, "claudeCode": true, "opencode": true, "codex": true },
  "paths": { "claudeHome": "~/.claude", "codexHome": "~/.codex" },
  "server": { "port": 9480, "retentionDays": 90 }
}
```

| 环境变量 | 说明 |
|---|---|
| `PIZZA_METRICS_SERVER_URL` | 云端地址(设置后 agent 自动开启推送) |
| `PIZZA_METRICS_API_KEY` | 共享密钥(server 设置后推拉端点要求 `x-api-key`) |
| `PIZZA_METRICS_USER` / `PIZZA_METRICS_AGENT_ID` | 身份覆盖 |
| `PIZZA_METRICS_INTERVAL` / `PIZZA_METRICS_PULL_PORT` | 采集间隔(默认 30s)/ 本地端口(默认 9465) |
| `PIZZA_METRICS_PUSH` / `PIZZA_METRICS_PULL` | 显式开关推/拉 |
| `PIZZA_METRICS_DB_FILE` / `PIZZA_METRICS_SERVER_PORT` | server 存储与端口(默认 9480) |

## HTTP API(云端)

| 方法/路径 | 说明 |
|---|---|
| `GET /` | 内置 dashboard(自动刷新,窗口/工具筛选) |
| `GET /api/v1/overview?window=7d&tool=&user=` | KPI 汇总:活跃用户、消耗、采纳率、按日/工具/用户/模型聚合 |
| `GET /api/v1/health` | 存活 + 样本数 + 已接入工具 |
| `GET /metrics` | Prometheus 文本格式 |
| `POST /api/v1/metrics` | agent 推送(JSON 增量) |
| `POST /v1/metrics` | OTLP/JSON(原生 OTel 工具) |

## 可选:Prometheus + Grafana 全家桶

```bash
cd deploy && docker compose up -d
# grafana: http://localhost:3000 (admin/admin,已预置 dashboard)
# prometheus: http://localhost:9090    otel-collector: :4317/:4318
```

`deploy/` 含 prometheus 抓取配置、otel-collector 配置(Claude Code 原生推送的另一条路径,
与内置 OTLP 端点二选一即可)、按 `agent_*` 指标定制的 Grafana dashboard。

## 设计取舍(为什么不是 Langfuse/Helicone)

调研结论(详见 `docs/design.md`):本平台只需**数值型 KPI**,而 Langfuse v3(6 容器)、
Helicone(代理网关型)、Phoenix(以 trace 为中心)都为 prompt/trace 调试而生,对三个
数值 KPI 而言基建过重。因此选择:

- **零依赖**(node:sqlite / node:http,与 pizza 同款引擎),`npm install` 即用;
- **增量(delta)为内部模型**:agent 断点续传 + 服务端幂等去重,崩溃/重试不重复计数;
- **Prometheus 文本格式作为拉取标准**,OTLP/JSON 作为推送标准,两边都是事实协议;
- Grafana 可选增强,不是前置依赖——一个 `serve` 进程就是完整平台。

## 已知边界

- 成本换算:来源未自带成本时(如 OpenCode 恒为 0、Claude Code 新版 transcript 无 costUSD),
  仅统计 token,不自行乘单价(避免维护价格表;需要时接 LiteLLM 价格表即可)。
- OTLP 仅支持 `http/json` 协议与 sum/gauge 类型(histogram 忽略);protobuf 请走
  deploy/ 中的 otel-collector 转换。
- Claude Code transcript 为内部格式,官方不承诺稳定;采纳率请走 OTel 指标。
- server 的 `/metrics` 与 GET API 未内置鉴权(推拉端点支持 `x-api-key`),公网部署请置于反代之后。

## 开发

```bash
npm run test    # 28 个 vitest 用例(归一化/适配器/agent/server 端到端)
npm run build   # tsc → dist/
```

目录:`src/adapters/`(各工具适配器)· `src/agent/`(端侧核心)· `src/server/`(云端)·
`src/normalize.ts`(统一指标模型与 OTLP 归一化)· `deploy/`(可选全家桶)。
