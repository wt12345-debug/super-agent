import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
import { allTools } from './tools'
import { ToolRegistry, type ToolDefinition } from './tools/register'
import { agentLoop, type BudgetState } from './agent/loop'
import { MCPClient } from './tools/mcp-client'
import { SessionStore } from './session/store'
import { PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext, type PromptContext } from './context/prompt-builder'
import { estimateMessageTokens } from './context/defense'
import { UsageTracker } from './usage/tracker'
import { createToolSearchTool } from './tools/tool-search' //// 注册 tool_search 元工具
import { MemoryStore } from './memory/store'  // 优化记忆存储
import { createDispatcher, type CommandContext } from './command/index'
import { contextCommands } from './command/context'
import { debugCommands } from './command/debug'
import { memoryCommands } from './command/memory'
import { dreamCommands } from './command/dream'
import { createMemoryTool } from './tools/memory-tools'
import { ragCommands } from './command/rag'
import { VectorStore } from './rag/store'
import { SqliteVectorStore } from './rag/sqlite-store.js'
import { createDashScopeEmbedder, embed } from './rag/embedder'
import { createRagTools } from './tools/rag-tools'
import { memoryContext, ragContext } from './context/prompt-pipes'
import fs from 'node:fs';
import { chunkDocument } from './rag/chunker'
import { SkillLoader } from './skills/loader'
import { createSkillCommands } from './command/skill'
import { PluginManager } from './plugins/manager'
import { type PluginDefinition } from './plugins/types'
import { supabasePlugin } from './plugins/supabase-plugin'
import { createPluginCommands } from './command/plugin'
import { createSecurityCommands } from './command/security'
import { HookPipeline } from './security/hook'
const qwen = createOpenAI({  // 创建 OpenAI 模型, 用于生成文本
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen3.8-flash') : createMockModel()

//------------ 注册工具-------------------
const registry = new ToolRegistry()
registry.register(...allTools)
registry.register(createToolSearchTool(registry))




//------------ 连接 github MCP服务器-------------------
async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import('node:child_process');
    execSync('echo test', { stdio: 'ignore' });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...');
    try {
      const client = new MCPClient(
        'pnpm', ['dlx', '@modelcontextprotocol/server-github'],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，无法连接 GitHub MCP Server。');
  }
}

// --------------- Memory --------------------
const memoryStore = new MemoryStore()
memoryStore.init()
registry.register(createMemoryTool(memoryStore))

// ------------------- Skills ------------------------
const skillLoader = new SkillLoader()  // skill 加载器
const loadedSkills = skillLoader.load()
const activeSkills = new Set<string>()
// ------------------- Plugins ------------------------
const pluginManager = new PluginManager(registry)

const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
])
// ------------------- Hook --------------------------
const hookPipeline = new HookPipeline()
// pre hook 示例
hookPipeline.registerPre('audit-log', (toolName, input) => {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = (input as any)?.path || 'unknown'
    console.log(` [audit] 文件写入操作： ${toolName} -> ${path}`);
  }
  return { action: 'allow' }
})
// post hook 示例
hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
  if (toolName === 'bash') {
    const timestamp = new Date().toISOString()
    return {
      action: 'modify',
      modifiedOutput: `[${timestamp}] \n${output}`
    }
  }
  return { action: 'allow' }
})
registry.setHookPipeline(hookPipeline)

// ------------------- Command ------------------------
const dispatch = createDispatcher([
  ...debugCommands,
  ...memoryCommands,
  ...contextCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createSecurityCommands(registry),
])

// ------------------- RAG ------------------------
// const vectorStore = new VectorStore()
const vectorStore = new SqliteVectorStore('knowledge.db')

const embedFn = createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY as string)
registry.register(...createRagTools(vectorStore, embedFn))

async function main() {
  await connectMCP();
  // 启动时自动加载插件
  console.log(' 加载插件...');
  for (const [name, def] of availablePlugins) {
    try {
      const tools = await pluginManager.load(def);
      console.log(`  [plugin] ${name} 已自动加载，注册 ${tools.length} 个工具`);
    } catch (err) {
      console.log(`  [plugin] ${name} 自动加载失败: ${err instanceof Error ? err.message : err}`);
    }
  }


  // Session 持久化
  const store = new SessionStore('default')
  let messages: ModelMessage[] = []
  const timestamps = new Map<number, number>() // 消息索引 -> 时间戳映射
  const tracker = new UsageTracker('.usage/today.jsonl')  // 用于跟踪token用量


  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))  // 在历史消息中挑选有价值的上下文
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext());

  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,  // 活跃工具数
      deferredToolSummary: registry.getDeferredToolSummary(),  // 延迟工具摘要
      sessionMessageCount: messages.length,
      sessionId: 'default'
    }
  }


  const rl = createInterface({   // 创建 readline 接口, 用于从命令行读取用户输入
    input: process.stdin,
    output: process.stdout,
  })


  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        //关闭所有插件的连接
        pluginManager.unloadAll()

        await registry.closeAllMCP();  // 关闭子进程的 MCP 连接
        rl.close();

        return;
      }
      const ctx: CommandContext = {
        messages, timestamps, registry, builder, tracker,
        sessionStore: store, model, makePromptCtx, ask, memoryStore, vectorStore
      }
      const handled = dispatch(trimmed, ctx)   // 处理用户输入，如果是指令...
      if (handled === 'async') return
      if (handled) {
        ask();
        return;
      }
      const userMsg: ModelMessage = { role: 'user', content: trimmed }

      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now())
      store.append(userMsg);

      const currentSystem = builder.build(makePromptCtx())
      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, currentSystem, tracker)
      //持久化 本轮新增加的消息 （包含Agent Loop中会往messages里面push的消息）
      const newMessages = messages.slice(beforeLen) //比如先前已有10条消息，用户输入了1条消息，原来messages中有了11条消息，那么newMessages就是这个问题模型回复的消息
      const now = Date.now()
      for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now)
      store.appendAll(newMessages)  // 追加的只有AgentLoop产生的消息

      console.log(` [Token] ~${estimateMessageTokens(messages)} tokens`);

      ask()
    });
  }

  console.log('Super Agent v0.16 — Memory system (type "exit" to quit)\n');
  console.log('快捷命令：');
  console.log(`  /memory            - 查看所有记忆`);
  console.log(`  /memory search     - 搜索记忆`);
  console.log(`  /skill             - 查看所有 Skill`);
  console.log(`  /skill load <name> - 加载指定 Skill`);
  console.log(`  /skill unload <name> - 卸载已激活指定 Skill`);
  console.log(`  /code-review       - 激活并执行 code-review Skill`);
  console.log(`  /context           - 终端里看 context 占用矩阵`);
  console.log(`  /usage            - 累计 token 用量和成本`);
  console.log(`  /rag               - 查看知识库状态`);
  console.log(`  ingest <path>      - 从文件导入知识`);
  console.log(`  status            - 当前消息数、token 和记忆数`);
  console.log('');
  console.log(` 已加载 ${memoryStore.list().length} 条历史记忆`);
  console.log('');

  if (loadedSkills.length > 0) {
    console.log(` 发现了 ${loadedSkills.length} 个 Skill`);
    for (const s of loadedSkills) {
      console.log(`  ${s.name} - ${s.description}`)
    }
    console.log('');
  }
  // if (fs.existsSync('docs')) {
  //   const files = fs.readdirSync('docs').filter(f => f.endsWith('.md'))
  //   if (files.length > 0) {
  //     console.log(` 发现 ${files.length} 个文档， 自动导入知识库...`);
  //     for (const f of files) {
  //       const path = `docs/${f}`
  //       const text = fs.readFileSync(path, 'utf-8')
  //       const chunks = chunkDocument(path, text)
  //       const embeddings = await embed(embedFn, chunks.map(c => c.text))
  //       vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })))
  //       console.log(`  ${f} -> ${chunks.length} 个片段`);
  //     }
  //     console.log(` 知识库准备就绪， 共 ${vectorStore.size()} 个片段\n`);
  //   }
  // }

  ask();

}

main().catch(console.error)