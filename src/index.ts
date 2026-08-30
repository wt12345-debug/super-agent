import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
import { allTools } from './tools/tools'
import { ToolRegistry } from './tools/tool-register'
import { agentLoop, type BudgetState } from './agent/loop'
import { MCPClient } from './tools/mcp-client'


const qwen = createOpenAI({  // 创建 OpenAI 模型, 用于生成文本
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
})
const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen3.8-27b') : createMockModel()

// 注册内置工具
const registry = new ToolRegistry()
registry.register(...allTools)


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
        'npx', ['-y', '@modelcontextprotocol/server-github'],
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

  console.log(`已注册: ${registry.getAll().length} 个工具`);
  for (const tool of registry.getAll()) {
    const flags = [
      tool.isConcurrencySafe ? '可并发' : '串行',
      tool.isReadOnly ? '只读' : '读写',
    ].join(', ')
    console.log(` -- ${tool.name}: ${flags}`)
  }

  const messages: ModelMessage[] = []
  const rl = createInterface({   // 创建 readline 接口, 用于从命令行读取用户输入
    input: process.stdin,
    output: process.stdout,
  })
  const budget: BudgetState = { used: 0, limit: 150000 }  // token 预算

  const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有内置工具和 MCP 工具可用。MCP 工具以 mcp__ 开头，如 mcp__github__list_issues。
需要查询 GitHub 信息时，使用 mcp__github__ 前缀的工具。
需要操作本地文件时，使用内置工具。
回答要简洁直接。`;

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        rl.close();
        return;
      }

      messages.push({ role: 'user', content: trimmed });

      await agentLoop(model, registry, messages, SYSTEM, budget)

      ask()
    });
  }

  console.log('Super Agent v0.5 — MCP (type "exit" to quit)\n');

  ask();

}

main().catch(console.error)