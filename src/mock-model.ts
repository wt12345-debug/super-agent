/**
 * Mock Model v0.14 — Skills
 *
 * 在 v0.12 RAG 的基础上，新增对记忆维护场景的意图识别：
 * - "lint 记忆 / 检查记忆"     → memory action=lint
 * - "搜记��� xxx / 找记忆 xxx" → memory action=search（结果走 BM25）
 *
 * 拿 system + tools 的指纹做"前缀稳定性"判断：
 * - 第一次见的 prefix → 全部记 cacheWrite
 * - 跟上一次一模一样 → 全部记 cacheRead
 * - prefix 变了（system 改了、工具增减、注入了时间戳）→ 又一次 cacheWrite
 */

let retryTestCount = 0;
let lastPrefixHash: string | null = null;
let cacheEnabled = true;

export function setCacheEnabled(enabled: boolean): void {
  cacheEnabled = enabled;
  if (!enabled) lastPrefixHash = null;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3.5);
}

function extractSystemContent(prompt: any[]): string {
  const sys = (prompt || []).find((m: any) => m.role === 'system');
  if (!sys) return '';
  if (typeof sys.content === 'string') return sys.content;
  if (Array.isArray(sys.content)) return sys.content.map((c: any) => c.text || '').join('');
  return '';
}

function approxMessageTokens(prompt: any[]): number {
  let chars = 0;
  for (const m of prompt || []) {
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const c of m.content as any[]) {
        if (c.type === 'text') chars += (c.text || '').length;
        else if (c.type === 'tool-call') chars += JSON.stringify(c.input || {}).length + 80;
        else if (c.type === 'tool-result') {
          const out = c.output;
          if (typeof out === 'string') chars += out.length;
          else if (out?.value) chars += String(out.value).length;
          else chars += JSON.stringify(out || {}).length;
          chars += 80;
        }
      }
    }
  }
  return approxTokensFromChars(chars);
}

/** 根据 prompt 算这次调用的 usage，并模拟 cache 命中。 */
function makeUsage(prompt: any[], outputChars = 80) {
  const system = extractSystemContent(prompt);
  const prefixContent = system;
  const prefixTokens = approxTokensFromChars(prefixContent.length);
  const messageTokens = approxMessageTokens(prompt);
  const outputTokens = approxTokensFromChars(outputChars);

  // 真实模型最小阈值各家不一（Qwen implicit 256、OpenAI 1024、Sonnet 4.7 2048、Opus 4.7 4096）。
  // 课程里用 512 让普通 SYSTEM 也能演示 cache 行为，等到讲生产配置时再讲各家阈值差异。
  const MIN_CACHE = 512;
  const cacheable = cacheEnabled && prefixTokens >= MIN_CACHE;

  const prefixHash = cacheable ? simpleHash(prefixContent) : null;
  let cacheRead = 0;
  let cacheWrite = 0;
  let input = messageTokens;

  if (cacheable) {
    if (lastPrefixHash === prefixHash) {
      cacheRead = prefixTokens;
    } else {
      cacheWrite = prefixTokens;
    }
    lastPrefixHash = prefixHash;
  } else {
    input += prefixTokens;
    lastPrefixHash = null;
  }

  // 返回 AI SDK v5 标准字段（number），跟真实模型一致
  // cacheCreationInputTokens 是 Anthropic provider 元数据里的字段名，AI SDK 透传
  return {
    inputTokens: input,
    outputTokens: outputTokens,
    totalTokens: input + outputTokens,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
  };
}

const TEXT_RESPONSES: Record<string, string> = {
  default:
    '你好！我是 Super Agent v0.15——现在支持 Plugin 动态加载了。试试 /plugin 看看已加载的插件，或者让我帮你查数据库。',
  greeting:
    '你好！我是 Super Agent v0.15，支持 Plugin 扩展。试试让我查数据库或者 /plugin 管理插件 :)',
  memorySaved:
    '好的，我已经把这条信息存到记忆里了。下次你重新打开对话，我还会记得这件事。',
  memoryRecalled:
    '让我查一下记忆...',
  lintFinished:
    '记忆库 lint 跑完了，详细情况看上面的报告。建议清理掉那些路径已经不存在的条目，或者把同名的合并一下。',
  dreamFinished:
    '记忆整理完成！这次做了以下操作：\n\n- 删除了 old-build-config（webpack.config.js 已不存在，854 天没读过）\n- 删除了 deploy-process-2（与 deploy-process 重名的早期版本）\n- 保留了 legacy-auth-module（路径过期但内容可能还有参考价值，建议手动更新）\n- 保留了 deploy-process（路径需要更新但部署流程本身还有用）\n- typescript-preference 健康，无需处理\n\n记忆库从 5 条精简到 3 条。',
};

interface ToolCallIntent {
  toolName: string;
  args: Record<string, unknown>;
}

function extractUserText(prompt: any[]): string {
  const userMsgs = (prompt || []).filter((m: any) => m.role === 'user');
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content.toLowerCase();
  return (last.content || [])
    .map((c: any) => c.text || '')
    .join('')
    .toLowerCase();
}

function hasToolResults(prompt: any[]): boolean {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'tool') return true;
    if (msgs[i].role === 'user') return false;
  }
  return false;
}

function getToolResultContent(prompt: any[]): string {
  const msgs = prompt || [];
  const parts: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'tool') {
      const content = msgs[i].content || [];
      for (const c of content) {
        const val = c.output?.value || c.output || c.result || '';
        parts.push(String(val));
      }
    } else if (msgs[i].role === 'user') break;
  }
  return parts.join('\n');
}

function wasToolSearchCalled(prompt: any[]): boolean {
  const msgs = prompt || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      const content = msgs[i].content || [];
      for (const c of content) {
        if (c.type === 'tool-call' && c.toolName === 'tool_search') return true;
      }
    }
    if (msgs[i].role === 'user') return false;
  }
  return false;
}

function detectParallelIntent(text: string): ToolCallIntent[] | null {
  if (text.includes('测试并发') || text.includes('test parallel')) {
    return [
      { toolName: 'get_weather', args: { city: '北京' } },
      { toolName: 'get_weather', args: { city: '上海' } },
      { toolName: 'list_directory', args: { path: '.' } },
    ];
  }
  return null;
}

function detectToolIntent(prompt: any[]): ToolCallIntent | null {
  const text = extractUserText(prompt);
  const toolResults = getToolResultContent(prompt);

  if (text.includes('测试死循环')) {
    return { toolName: 'get_weather', args: { city: '北京' } };
  }

  // Dream flow — 多步记忆整理
  if (text.includes('阶段 1') && text.includes('阶段 2') && text.includes('记忆整理') || text.includes('dream')) {
    if (!hasToolResults(prompt)) {
      // Step 1: 先 list
      return { toolName: 'memory', args: { action: 'list' } };
    }
    const combined = getToolResultContent(prompt);
    if (combined.includes('记忆列表') && !combined.includes('lint 报告')) {
      // Step 2: list 完了，跑 lint
      return { toolName: 'memory', args: { action: 'lint' } };
    }
    const deletedOld = combined.includes('已删除: project_old-build-config') || combined.includes('文件不存在: project_old-build-config');
    const deletedDup = combined.includes('已删除: project_deploy-process-2') || combined.includes('文件不存在: project_deploy-process-2');
    if (combined.includes('lint 报告') && !deletedOld) {
      // Step 3: lint 完了，删掉 old-build-config
      return { toolName: 'memory', args: { action: 'delete', filename: 'project_old-build-config.md' } };
    }
    if (deletedOld && !deletedDup) {
      // Step 4: 删重名的那条
      return { toolName: 'memory', args: { action: 'delete', filename: 'project_deploy-process-2.md' } };
    }
    // Step 5: done
    return null;
  }

  // Memory tool — lint intent（必须排在 save 前面，避免被"记住"误吞）
  if ((text.includes('lint 记忆') || text.includes('检查记忆') || text.includes('记忆体检') || text === 'lint') && !hasToolResults(prompt)) {
    return { toolName: 'memory', args: { action: 'lint' } };
  }

  // Memory tool — save intent
  if ((text.includes('记住') || text.includes('remember')) && !hasToolResults(prompt)) {
    const content = text.replace(/记住|remember/g, '').trim();
    const isPreference = content.includes('喜欢') || content.includes('偏好') || content.includes('prefer');
    const isFeedback = content.includes('不要') || content.includes('别') || content.includes('don\'t');
    const type = isFeedback ? 'feedback' : isPreference ? 'user' : 'project';
    return { toolName: 'memory', args: {
      action: 'save',
      name: content.slice(0, 30),
      description: content.slice(0, 60),
      type,
      content,
    }};
  }

  // Memory tool — list intent
  if ((text.includes('我的记忆') || text.includes('记忆列表') || text === 'memory list') && !hasToolResults(prompt)) {
    return { toolName: 'memory', args: { action: 'list' } };
  }

  // Memory tool — search intent（BM25）
  if ((text.includes('搜记忆') || text.includes('搜索记忆') || text.includes('找记忆') || text.includes('memory search')) && !hasToolResults(prompt)) {
    const query = text
      .replace(/搜记忆|搜索记忆|找记忆|memory search/g, '')
      .replace(/^[关于的有]+/, '')
      .trim() || 'all';
    return { toolName: 'memory', args: { action: 'search', query } };
  }

  // RAG tool — ingest intent
  if ((text.includes('导入') || text.includes('ingest')) && (text.includes('文档') || text.includes('.md')) && !hasToolResults(prompt)) {
    const pathMatch = text.match(/([\w/.-]+\.md)/);
    const path = pathMatch ? pathMatch[1] : 'docs/deployment-guide.md';
    return { toolName: 'rag_ingest', args: { path } };
  }

  // Plugin tools — supabase (直接调用，不需要 tool_search)
  if (!hasToolResults(prompt) && (
    text.includes('有哪些表') || text.includes('表列表') || text.includes('list table')
  )) {
    return { toolName: 'supabase__list_tables', args: {} };
  }
  if (!hasToolResults(prompt) && (
    text.includes('查用户') || text.includes('用户数据') || text.includes('query user')
  )) {
    return { toolName: 'supabase__query', args: { table: 'users' } };
  }
  if (!hasToolResults(prompt) && (
    text.includes('查帖子') || text.includes('文章列表') || text.includes('query post')
  )) {
    return { toolName: 'supabase__query', args: { table: 'posts' } };
  }
  if (!hasToolResults(prompt) && (
    text.includes('插入') || text.includes('新增') || text.includes('insert')
  )) {
    return { toolName: 'supabase__insert', args: { table: 'users', data: { name: '赵六', email: 'zhao@example.com', role: 'user' } } };
  }
  if (!hasToolResults(prompt) && (
    text.includes('数据库') || text.includes('database') || text.includes('supabase') || text.includes('sql')
  )) {
    return { toolName: 'supabase__list_tables', args: {} };
  }

  // RAG tool — search intent
  if (!hasToolResults(prompt) && (
    text.includes('部署') || text.includes('deploy') || text.includes('事故') ||
    text.includes('回滚') || text.includes('监控') || text.includes('迁移') ||
    text.includes('知识库') || text.includes('搜索知识') || text.includes('查资料')
  )) {
    return { toolName: 'rag_search', args: { query: text } };
  }

  // 如果刚刚 tool_search 返回了结果，现在要调用发现的工具
  if (hasToolResults(prompt) && wasToolSearchCalled(prompt)) {
    if (toolResults.includes('list_issues') || toolResults.includes('mcp__github')) {
      const repoMatch = text.match(/(\w+)\/(\w[\w-]*)/);
      const owner = repoMatch ? repoMatch[1] : 'vercel';
      const repo = repoMatch ? repoMatch[2] : 'ai';
      return { toolName: 'mcp__github__list_issues', args: { owner, repo } };
    }
    if (toolResults.includes('search_pages') || toolResults.includes('mcp__notion')) {
      return { toolName: 'mcp__notion__search_pages', args: { query: 'project roadmap' } };
    }
    if (toolResults.includes('navigate') || toolResults.includes('mcp__browser')) {
      return { toolName: 'mcp__browser__navigate', args: { url: 'https://example.com' } };
    }
    return null;
  }

  if (hasToolResults(prompt)) return null;

  // 延迟工具场景：先 tool_search，传精确的工具名
  if (text.includes('issue') || text.includes('issues') || text.includes('github')) {
    return { toolName: 'tool_search', args: { query: 'mcp__github__list_issues' } };
  }
  if (text.includes('notion') || text.includes('笔记')) {
    return { toolName: 'tool_search', args: { query: 'mcp__notion__search_pages' } };
  }
  if (text.includes('浏览器') || text.includes('browser') || text.includes('网页')) {
    return { toolName: 'tool_search', args: { query: 'mcp__browser__navigate' } };
  }

  // 内置工具（非延迟，直接调用）
  if (text.includes('测试截断') || text.includes('test truncation')) {
    return { toolName: 'read_file', args: { path: 'sample-data.txt' } };
  }
  if (text.includes('测试编辑') || text.includes('test edit')) {
    return { toolName: 'edit_file', args: { path: 'sample-data.txt', old_string: '一、工具注册机制', new_string: '一、工具注册机制（已更新）' } };
  }
  if (text.includes('测试搜索') || text.includes('test grep')) {
    return { toolName: 'grep', args: { pattern: 'export', path: 'src' } };
  }
  if (text.includes('测试glob') || text.includes('test glob')) {
    return { toolName: 'glob', args: { pattern: '**/*.ts' } };
  }
  if (text.includes('测试bash') || text.includes('test bash')) {
    return { toolName: 'bash', args: { command: 'echo "Hello from bash!" && date' } };
  }
  if (text.includes('目录') || text.includes('文件列表') || text.includes('ls')) {
    return { toolName: 'list_directory', args: { path: '.' } };
  }

  const fileMatch = text.match(/(\S+\.[\w]+)/);
  if (fileMatch && (text.includes('读') || text.includes('read') || text.includes('看看') || text.includes('查看') || text.includes('打开') || text.includes('文件') || text.includes('file'))) {
    return { toolName: 'read_file', args: { path: fileMatch[1] } };
  }

  const weatherKeywords = ['天气', 'weather', '温度', '热', '冷', '气温'];
  const hasWeatherIntent = weatherKeywords.some((kw) => text.includes(kw));
  const cities = text.match(/(北京|上海|深圳|广州|杭州|成都)/g);
  if (hasWeatherIntent && cities && cities.length > 0) {
    return { toolName: 'get_weather', args: { city: cities[0] } };
  }

  const calcMatch = text.match(/(\d+)\s*[+\-*/加减乘除]\s*(\d+)/);
  if (calcMatch) {
    const op = text.match(/[+*/]|加|减|乘|除|-/)?.[0] || '+';
    const opMap: Record<string, string> = { '加': '+', '减': '-', '乘': '*', '除': '/' };
    const expression = `${calcMatch[1]} ${opMap[op] || op} ${calcMatch[2]}`;
    return { toolName: 'calculator', args: { expression } };
  }

  return null;
}

function pickTextResponse(prompt: any[]): string {
  const text = extractUserText(prompt);

  if (hasToolResults(prompt)) {
    const combined = getToolResultContent(prompt);

    // Memory tool responses
    if (combined.includes('已保存到记忆') || combined.includes('saved to memory')) {
      return TEXT_RESPONSES.memorySaved;
    }
    // Dream 完成——两条都处理完了
    if ((text.includes('dream') || text.includes('记忆整理')) &&
        (combined.includes('project_deploy-process-2'))) {
      return TEXT_RESPONSES.dreamFinished;
    }
    if (combined.includes('lint 报告') || combined.includes('记忆库健康')) {
      return `${TEXT_RESPONSES.lintFinished}\n\n${combined}`;
    }
    if (combined.includes('BM25 搜索结果')) {
      return `给你按相关度排好的搜索结果：\n${combined}`;
    }
    if (combined.includes('记忆列表') || combined.includes('条记忆')) {
      return `这是你目前的记忆：\n${combined}`;
    }

    // Plugin tool responses (supabase)
    if (combined.includes('tables') && combined.includes('users')) {
      return `数据库里有这些表：\n${combined}`;
    }
    if (combined.includes('"table"') && combined.includes('"rows"')) {
      return `查询结果如下：\n${combined}`;
    }
    if (combined.includes('"success":true') && combined.includes('"inserted"')) {
      return `数据插入成功：\n${combined}`;
    }

    // RAG tool responses
    if (combined.includes('已导入') && combined.includes('文档片段')) {
      return `文档已导入知识库。${combined}`;
    }
    if (combined.includes('综合分') || combined.includes('来源:')) {
      return `根据知识库的检索结果：\n\n${combined}`;
    }
    if (combined.includes('知识库为空')) {
      return combined;
    }

    if (combined.includes('搜索结果') || combined.includes('没有找到')) {
      return combined;
    }

    if (combined.includes('[DIR]') || combined.includes('[FILE]')) {
      return `当前目录的文件列表：\n${combined}`;
    }
    if (combined.includes('°C') || combined.includes('天气')) {
      return `根据查询结果：${combined}`;
    }
    if (combined.includes('已发送') || combined.includes('已导航') || combined.includes('已点击') || combined.includes('已填写')) {
      return `操作完成：${combined}`;
    }
    if (combined.includes('number') || combined.includes('title') || combined.includes('state')) {
      return `查询结果：\n${combined}`;
    }
    return `工具返回了以下信息：\n${combined}`;
  }

  if (text.includes('你好') || text.includes('hello') || text.includes('hi'))
    return TEXT_RESPONSES.greeting;
  return TEXT_RESPONSES.default;
}

function createDelayedStream(chunks: any[], delayMs = 30): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          setTimeout(next, delayMs);
        } else {
          controller.close();
        }
      }
      next();
    },
  });
}

function makeToolCallChunks(intents: ToolCallIntent[], prompt: any[]): any[] {
  const chunks: any[] = [];
  for (const intent of intents) {
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const argsJson = JSON.stringify(intent.args);
    chunks.push(
      { type: 'tool-input-start', id: callId, toolName: intent.toolName },
      { type: 'tool-input-delta', id: callId, delta: argsJson },
      { type: 'tool-input-end', id: callId },
      { type: 'tool-call', toolCallId: callId, toolName: intent.toolName, input: argsJson },
    );
  }
  chunks.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: makeUsage(prompt) });
  return chunks;
}

export function createMockModel() {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'mock-model',

    get supportedUrls() {
      return Promise.resolve({});
    },

    async doGenerate({ prompt }: any) {
      // Detect compression request (called via generateText with compress system prompt)
      const allText = (prompt || []).map((m: any) => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.map((c: any) => c.text || '').join('');
        return '';
      }).join(' ');

      if (allText.includes('对话压缩系统') || allText.includes('压缩成一份结构化摘要')) {
        const mockSummary = `## 用户意图\n用户在探索项目结构和代码，了解工具系统的设计。\n\n## 已完成的操作\n- 列出了当前目录文件（.env, package.json, sample-data.txt, src/）\n- 读取了 package.json（项目名 super-agent-08-compaction, 版本 0.8.0）\n- 读取了 sample-data.txt（工具系统设计文档）\n- 搜索了 src/ 目录中的 export（找到 ToolRegistry, agentLoop, SessionStore 等导出）\n\n## 关键发现\n- 项目使用 ai@5.0.98 和 @ai-sdk/openai@2.0.44\n- 工具系统包含 ToolRegistry、truncateResult、并发控制（读写锁）\n- 已实现 SessionStore（JSONL 持久化）和 PromptBuilder（模块化 Prompt）\n\n## 当前状态\n用户刚完成项目结构探索，尚未开始修改代码。\n\n## 需要保留的细节\n- 项目路径：当前工作目录\n- 关键文件：src/tool-registry.ts, src/agent-loop.ts, src/context-compressor.ts`;
        return {
          content: [{ type: 'text' as const, text: mockSummary }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      const text = extractUserText(prompt);

      if (text.includes('测试重试') || text.includes('test retry')) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded');
        }
        retryTestCount = 0;
        return {
          content: [{ type: 'text' as const, text: '重试成功！' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      const parallelIntents = detectParallelIntent(text);
      if (parallelIntents && !hasToolResults(prompt)) {
        return {
          content: parallelIntents.map(intent => ({
            type: 'tool-call' as const,
            toolCallId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: intent.toolName,
            input: intent.args,
          })),
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      const intent = detectToolIntent(prompt);
      if (intent) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `call-${Date.now()}`,
            toolName: intent.toolName,
            input: intent.args,
          }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(prompt),
          warnings: [],
        };
      }

      return {
        content: [{ type: 'text' as const, text: pickTextResponse(prompt) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: makeUsage(prompt),
        warnings: [],
      };
    },

    async doStream({ prompt }: any) {
      const text = extractUserText(prompt);

      if (text.includes('测试重试') || text.includes('test retry')) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded');
        }
        retryTestCount = 0;
        const reply = '重试成功！';
        const id = 'text-1';
        const chunks: any[] = [
          { type: 'text-start', id },
          ...reply.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
          { type: 'text-end', id },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: makeUsage(prompt) },
        ];
        return { stream: createDelayedStream(chunks, 30) };
      }

      const parallelIntents = detectParallelIntent(text);
      if (parallelIntents && !hasToolResults(prompt)) {
        return { stream: createDelayedStream(makeToolCallChunks(parallelIntents, prompt), 15) };
      }

      const intent = detectToolIntent(prompt);
      if (intent) {
        return { stream: createDelayedStream(makeToolCallChunks([intent], prompt), 20) };
      }

      const replyText = pickTextResponse(prompt);
      const id = 'text-1';
      const chunks: any[] = [
        { type: 'text-start', id },
        ...replyText.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
        { type: 'text-end', id },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: makeUsage(prompt) },
      ];
      return { stream: createDelayedStream(chunks, 30) };
    },
  };
}