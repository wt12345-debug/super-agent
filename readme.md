# Super Agent

基于 [Vercel AI SDK](https://ai-sdk.dev/) 的多 Agent 命令行框架。内置 Agent Loop、四层上下文管理、工具系统、记忆/检索（RAG）、定时任务、安全基线，并支持子 Agent（sub-agent）与 MCP 工具扩展。开箱即可作为你的私有 AI 助手使用。

## ✨ 核心特性

- **Agent Loop**：自研的 `think → act → observe` 交互循环，可在每轮工具调用之间插入自定义逻辑（日志、缓存、令牌统计等），相比 SDK 内置自动循环可定制性更强。
- **多 Agent**：支持衍生子 Agent（`agents`），可配置最大生成深度与最大并发。
- **工具系统**：文件读写、Shell、网页搜索、记忆、RAG、Cron、子 Agent 派生、工具自搜索（`tool-search`）等。
- **四层上下文管理**：截断、时间衰减修剪、LLM 摘要压缩、Cache 优化，控制长对话的令牌消耗。
- **记忆 + RAG**：持久化记忆（`memory`）与文档向量检索（基于 `sqlite-vec`），可把 `docs/` 下的 Markdown 自动导入知识库。
- **定时任务（Cron）**：内置 cron 调度，可让 Agent 定时执行提示词。
- **安全基线**：角色权限（`security`）、写文件审计、bash 输出时间戳、死循环检测与重试。
- **MCP 客户端**：默认接入 GitHub MCP Server，可扩展其他 MCP 工具。
- **命令系统**：`/memory`、`/rag`、`/cron`、`/agents`、`/role`、`/plugin` 等内置斜杠命令。

## 📦 环境要求

- **Node.js** ≥ 20
- **pnpm** ≥ 11（版本见 `package.json` 的 `packageManager` 字段）

## 🚀 安装

```bash
git clone https://github.com/<your-name>/super-agent.git
cd super-agent
pnpm install
```

> 注意：`better-sqlite3`、`sqlite-vec` 等为原生依赖，`pnpm install` 时会自动编译，需要本机具备 Node.js 构建环境（Windows 上一般可直接安装预编译版本）。

## ⚙️ 配置

### 方式一：交互式初始化（推荐）

```bash
pnpm run init
```

按向导选择模型、输入你的 DashScope API Key，会自动生成 `super-agent.config.json` 和 `.env`。

### 方式二：手动配置

1. 复制并编辑配置文件：

   ```bash
   cp super-agent.config.json.example super-agent.config.json
   ```

2. 创建 `.env`，至少填入模型 API Key（DashScope / 阿里云百炼 通义千问兼容接口）：

   ```env
   DASHSCOPE_API_KEY=sk-xxxxx
   ```

   `super-agent.config.json` 中 `model.apiKey` 支持环境变量占位符：

   ```json
   {
     "model": {
       "provider": "dashscope",
       "name": "qwen3.8-flash",
       "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
       "apiKey": "${DASHSCOPE_API_KEY}"
     }
   }
   ```

### 可选环境变量（增强网页搜索）

在 `.env` 中配置 `TAVILY_API_KEY` 或 `SERPER_API_KEY` 以启用联网搜索工具；配置 `GITHUB_PERSONAL_ACCESS_TOKEN` 以启用 GitHub MCP 工具。

## ▶️ 使用

```bash
# 启动新会话
pnpm start

# 或在项目存在继承会话时续接
pnpm run continue
```

进入交互后直接输入问题即可，例如：

```
帮我对比 Hono、Fastify 和 Express 的性能和生态
```

内置快捷命令：

| 命令 | 说明 |
| --- | --- |
| `/agents` | 查看子 Agent 执行记录 |
| `/cron` | 查看/管理定时任务 |
| `/memory` | 查看/管理记忆 |
| `/rag` | 知识库操作 |
| `/role [角色]` | 查看/切换权限角色 |
| `/plugin` | 插件管理 |
| `exit` | 退出会话 |

## 📁 配置参考（`super-agent.config.json`）

| 字段 | 说明 |
| --- | --- |
| `model` | 模型提供方、名称、`baseURL`、`apiKey`（支持 `${ENV}` 占位） |
| `agents` | 子 Agent：`maxSpawnDepth`（最大生成深度）、`maxConcurrent`（最大并发）、`defaultTimeout` |
| `security` | `defaultRole`（默认权限角色）、`auditLog`（写文件审计）、`bashTimestamp`（bash 输出加时间戳） |
| `memory` / `rag` / `cron` | 记忆、RAG、定时任务开关与数据目录 |
| `plugins` | 扩展插件列表（如 `supabase`，默认关闭） |

## 🗂️ 目录结构

```
src/
  agent/       Agent Loop、死循环检测、重试
  context/     提示词构建、上下文压缩与防御
  tools/       工具系统、MCP 客户端、工具自搜索
  agents/      子 Agent 注册与派生
  memory/      持久化记忆
  rag/         向量库、分块、检索
  security/    角色权限、Hook 管线、命令分类
  cron/        定时任务
  skills/      技能加载
  plugins/     插件管理
  config/      配置加载与初始化向导
  command/     内置斜杠命令
```

## 📄 License

[MIT](LICENSE)