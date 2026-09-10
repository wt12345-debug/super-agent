import 'dotenv/config';
import { loadConfig } from './config/loader.js';
import type { SuperAgentConfig } from './config/schema.js';
import fs from 'node:fs';
import { type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createMockModel } from './mock-model.js';
import { createInterface } from 'node:readline';
import { ToolRegistry } from './tools/register.js';
import { allTools } from './tools/index.js';
import { createToolSearchTool } from './tools/tool-search.js';
import { createMemoryTool } from './tools/memory-tools.js';
import { createRagTools } from './tools/rag-tools.js';
import { agentLoop } from './agent/loop.js';
import { SessionStore } from './session/store.js';
import {
  PromptBuilder, coreRules, toolGuide, deferredTools, sessionContext,
  type PromptContext,
} from './context/prompt-builder.js';
import { estimateMessageTokens } from './context/defense.js';
import { UsageTracker } from './usage/tracker.js';
import { MemoryStore } from './memory/store.js';
import { memoryContext, ragContext } from './context/prompt-pipes.js';
import { chunkDocument } from './rag/chunker.js';
import { createDashScopeEmbedder, embed } from './rag/embedder.js';
import { SqliteVectorStore as VectorStore } from './rag/sqlite-store.js';
import { createDispatcher, type CommandContext } from './command/index.js';
import { debugCommands } from './command/debug.js';
import { contextCommands } from './command/context.js';
import { memoryCommands } from './command/memory.js';
import { ragCommands } from './command/rag.js';
import { dreamCommands } from './command/dream.js';
import { SkillLoader } from './skills/loader.js';
import { createSkillCommands } from './command/skill.js';
import { PluginManager } from './plugins/manager.js';
import { supabasePlugin } from './plugins/supabase-plugin.js';
import { createPluginCommands } from './command/plugin.js';
import type { PluginDefinition } from './plugins/types.js';
import { HookPipeline } from './security/hook.js';
import { createSecurityCommands } from './command/security.js';
import { CronService } from './cron/service.js';
import { createCronTool } from './tools/cron-tools.js';
import { createCronCommands } from './command/cron.js';
import { SubAgentRegistry } from './agents/registry.js';
import { createSpawnTool } from './tools/spawn-tools.js';
import { createAgentCommands } from './command/agent.js';
import type { SpawnContext } from './agents/spawn.js';
import { MCPClient } from './tools/mcp-client'

// ── 加载配置 ────────────────────────────────
const config = loadConfig();

function createModel(cfg: SuperAgentConfig['model']) {
  if (!cfg.apiKey) return createMockModel();
  const provider = createOpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  return provider.chat(cfg.name);
}
const model = createModel(config.model);

// ── Registry ────────────────────────────────────────
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));

// ── Memory ────────────────────────────────────────
const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
registry.register(createMemoryTool(memoryStore));

// ── RAG ────────────────────────────────────────
const vectorStore = new VectorStore();
const embedFn = config.model.apiKey
  ? createDashScopeEmbedder(config.model.apiKey)
  : embed as any;
registry.register(...createRagTools(vectorStore, embedFn));

async function connectMCP() {
  const mcpClient = new MCPClient(
    'pnpm', ['dlx', '@modelcontextprotocol/server-github'],
    { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN as string },
  );
  const tools = await registry.registerMCPServer('github', mcpClient);
  console.log(`  已注册 ${tools.length} 个 MCP 工具`);
}

// ── Skills ────────────────────────────────────────
const skillLoader = new SkillLoader('.');
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();

// ── Plugins ────────────────────────────────────────
const pluginManager = new PluginManager(registry);
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);

// ── Security: Hook Pipeline ────────────────────────────────────────
const hookPipeline = new HookPipeline();

hookPipeline.registerPre('audit-log', (toolName, input) => {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = (input as any)?.path || 'unknown';
    console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
  }
  return { action: 'allow' };
});

hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
  if (toolName === 'bash') {
    const timestamp = new Date().toISOString();
    return {
      action: 'modify',
      modifiedOutput: `[${timestamp}]\n${output}`,
    };
  }
  return { action: 'allow' };
});

registry.setHookPipeline(hookPipeline);

// ── Cron Service ────────────────────────────────────────
const cronService = new CronService(config.cron.dataDir);
registry.register(createCronTool(cronService));

// ── Sub-Agent ────────────────────────────────────────
const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
});

function getSpawnCtx(): SpawnContext {
  return {
    model,
    registry,
    agentRegistry,
    buildSystem: () => builder.build(makePromptCtx()),
    currentDepth: 0,
  };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));

// ── Prompt Builder ────────────────────────────────────────
const builder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('ragContext', ragContext(vectorStore))
  .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
  .pipe('sessionContext', sessionContext());


// ── Commands ────────────────────────────────────────
const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
  ...createSkillCommands(skillLoader, activeSkills),
  ...createPluginCommands(pluginManager, availablePlugins),
  ...createSecurityCommands(registry, hookPipeline),
  ...createCronCommands(cronService),
  ...createAgentCommands(agentRegistry),
]);

function makePromptCtx(): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: 0,
    sessionId: config.session.id,
  };
}

export async function startAgent() {
  await connectMCP();

  // 加载插件
  console.log('  加载插件...');
  for (const [name, def] of availablePlugins) {
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${name} — 加载失败`);
    }
  }


  // 启动 Cron
  cronService.load();
  cronService.setExecutor({
    runAgentPrompt: async (prompt, timeout) => {
      const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }];
      const system = builder.build(makePromptCtx());
      await agentLoop(model, registry, cronMessages, system);
      const lastMsg = cronMessages[cronMessages.length - 1];
      if (!lastMsg) return '(无输出)';
      if (typeof lastMsg.content === 'string') return lastMsg.content;
      if (Array.isArray(lastMsg.content)) {
        return lastMsg.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
      return String(lastMsg.content);
    },
    notify: (message) => {
      console.log(`\n${message}`);
    },
  });
  cronService.start();
  const cronJobs = cronService.list();

  const store = new SessionStore('default');
  let messages: ModelMessage[] = [];
  const timestamps = new Map<number, number>();
  const tracker = new UsageTracker('.usage/today.jsonl');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        cronService.stop();
        await pluginManager.unloadAll();
        rl.close();
        return;
      }

      const ctx: CommandContext = {
        messages, timestamps, registry, builder, tracker,
        sessionStore: store, model, makePromptCtx, ask,
        memoryStore, vectorStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === 'async') return;
      if (handled) { ask(); return; }

      const userMsg: ModelMessage = { role: 'user', content: trimmed };
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      const currentSystem = builder.build(makePromptCtx());
      const beforeLen = messages.length;
      await agentLoop(model, registry, messages, currentSystem, tracker);

      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) timestamps.set(i, now);
      store.appendAll(newMessages);

      console.log(`  [Token] ~${estimateMessageTokens(messages)} tokens`);
      ask();
    });
  }

  const role = registry.getRole();
  const toolCount = registry.getActiveTools().length;
  const hooks = hookPipeline.list();

  console.log('Super Agent v1.0 (type "exit" to quit)');
  console.log('快捷命令：');
  console.log('  /agents           — 查看子 Agent 记录');
  console.log('  /cron             — 查看定时任务');
  console.log('  /role [角色]      — 查看/切换角色');
  console.log('');
  console.log(`  当前角色: ${role}，可用工具: ${toolCount} 个`);
  console.log(`  Sub-Agent: 最大深度 ${agentRegistry.getConfig().maxSpawnDepth}，最大并发 ${agentRegistry.getConfig().maxConcurrent}`);
  console.log('');
  console.log('  试试：');
  console.log('    帮我对比 Hono、Fastify 和 Express 的性能和生态');
  console.log('    /agents       — 查看子 Agent 执行记录');
  console.log('');

  if (fs.existsSync('docs')) {
    const files = fs.readdirSync('docs').filter(f => f.endsWith('.md'));
    if (files.length > 0) {
      console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
      for (const f of files) {
        const path = `docs/${f}`;
        const text = fs.readFileSync(path, 'utf-8');
        const chunks = chunkDocument(path, text);
        const embeddings = await embed(embedFn, chunks.map(c => c.text));
        vectorStore.addBatch(chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })));
      }
      console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
    }
  }

  ask();
}

