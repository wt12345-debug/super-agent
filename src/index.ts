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
import { summarize, estimateTokens, microcompact } from './context/compressor'
import { applyDefense, estimateMessageTokens, TokenTracker } from './context/defense'
import { UsageTracker } from './usage/tracker'

const qwen = createOpenAI({  // 创建 OpenAI 模型, 用于生成文本
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen3.8-flash') : createMockModel()

// 注册内置工具
const registry = new ToolRegistry()
registry.register(...allTools)


// 成本追踪
const tracker = new UsageTracker('.usage/today.jsonl')

// 注册 tool_search 元工具
const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义，传入工具名(从系统提示的延迟工具列表中获取)，返回该工具的完整 Schema',
  parameters: { type: 'object', properties: { query: { type: 'string', description: '工具名,如"mcp__github__list__issues"等。支持逗号分隔多个工具名' } }, required: ['query'] },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: any) => {
    const results = registry.searchTools(query)  // 搜出来哪些工具的searchHint 包含 query 中的字符串
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }
}
registry.register(toolSearchTool)

// 连接MCP服务器
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


async function main() {
  await connectMCP();
  // Session持久化
  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)
  const timestamps = new Map<number, number>()
  const tokenTracker = new TokenTracker()  // 用于跟踪token用量

  let messages: ModelMessage[] = []
  if (isContinue && store.exists()) {
    messages = store.load()
    tokenTracker.addMessages(messages)  // 更新tokenTracker
    console.log(`[Session] 恢复会话，共 ${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }


  
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext())

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length, // 活跃工具数
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  }
  const SYSTEM = builder.build(promptCtx)
  builder.debug(promptCtx)
  // 压缩的三层防御
  const beforeTokens = estimateMessageTokens(messages)
  console.log(`\n=== 三层即时防线 ===`);
  console.log(`[\n防线前] ${messages.length} 条消息, ~ ${beforeTokens} 个 token`);

  const defense = applyDefense(messages, timestamps)
  tokenTracker.replaceMessages(messages, defense.messages)
  messages = defense.messages  // 被压缩后的消息
  console.log(`[Layer 2: 截断] ${defense.truncated} 个超长结果被截断`);
  console.log(`[Layer 3: TTL] ${defense.softPruned} 个软修剪, ${defense.hardPruned} 个硬修剪`);
  console.log(`[防线后] ${messages.length} 条消息, ~${defense.tokenEstimate} tokens （节省了${beforeTokens - defense.tokenEstimate}）`);

  console.log(tokenTracker.status);  // 是否需要触发摘要压缩
  
  // 启动时压缩
  // const beforeToken = estimateTokens(messages)
  // console.log(`[\n压缩前] ${messages.length} 条消息, ~ ${beforeToken} 个 token`);

  // const mc = microcompact(messages)
  // messages = mc.messages
  // const afterMCToken = estimateTokens(messages)
  // console.log(`[Layer 1: Microcompact] 清理了 ${mc.cleared} 条工具调用结果, ~ ${afterMCToken} 个 token`);

  // let summary = ''
  // const compResult = await summarize(model, messages, summary)
  // messages = compResult.messages
  // summary = compResult.summary
  // const afterSumToken = estimateTokens(messages)
  // if (compResult.compressedCount > 0) {
  //   console.log(`[Layer 2: Summarize] 压缩了 ${compResult.compressedCount} 条消息, ~ ${afterSumToken} 个 token`);
  //   console.log(`[摘要预览] ${summary.slice(0, 150)}...`);
  // } else {
  //   console.log('[Layer 2: Summarize] 未触发摘要压缩');
  // }


  const rl = createInterface({   // 创建 readline 接口, 用于从命令行读取用户输入
    input: process.stdin,
    output: process.stdout,
  })


  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        await registry.closeAllMCP();  // 关闭子进程的 MCP 连接
        rl.close();

        return;
      }
      const userMsg: ModelMessage = { role: 'user', content: trimmed }

      messages.push(userMsg);
      store.append(userMsg);

      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, SYSTEM, tracker)
      //持久化 本轮新增加的消息 （包含Agent Loop中会往messages里面push的消息）
      const newMessages = messages.slice(beforeLen) //比如先前已有10条消息，用户输入了1条消息，原来messages中有了11条消息，那么newMessages就是这个问题模型回复的消息
      store.appendAll(newMessages)  // 追加的只有AgentLoop产生的消息

      ask()
    });
  }

  console.log('Super Agent v0.6 — MCP (type "exit" to quit)\n');

  ask();

}

main().catch(console.error)