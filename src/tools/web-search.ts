import type { ToolDefinition } from './register'
import TurndownService from 'turndown'
// Tavily 搜索引擎
export const tavilySearchTool: ToolDefinition = {
    name: 'web_search',
    description: '搜索互联网最新信息。返回相关网页的标题,链接和内容摘要',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '搜索关键词',
            },
            max_results: {
                type: 'number',
                description: '返回最大结果数量，默认5个',
            },
        },
        required: ['query'],
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ query, max_results = 5 }: { query: string, max_results?: number }) => {
        const apikey = process.env.TAVILY_API_KEY;
        if (!apikey) return `[web_search] 未配置Tavily API Key，请在.env文件中配置TAVILY_API_KEY`
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apikey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query,
                max_results,
                include_answer: true,
            }),
        })
        if (!res.ok) return `[web_search] Tavily请求失败，状态码：${res.status}`

        const data = await res.json() as any;
        const lines: string[] = []

        if (data.answer) {
            lines.push(`# AI摘要\n${data.answer}\n`)
        }
        for (const r of data.results || []) {
            lines.push(`### ${r.title}`);
            lines.push(r.url);
            lines.push(r.content || '');
            lines.push('');
        }
        return lines.join('\n') || '没有找到相关结果';

    }
}
// Serper 搜索引擎
export const serperSearchTool: ToolDefinition = {
    name: 'web_search',
    description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: '搜索关键词' },
            max_results: { type: 'number', description: '返回结果数量，默认 5' },
        },
        required: ['query'],
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 3000,
    execute: async ({ query, max_results = 5 }: { query: string; max_results?: number }) => {
        const apiKey = process.env.SERPER_API_KEY;
        if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置';

        const res = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ q: query, num: max_results }),
        });

        if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

        const data = await res.json() as any;
        const lines: string[] = [];

        // Knowledge Graph（如果有）
        if (data.knowledgeGraph) {
            const kg = data.knowledgeGraph;
            lines.push(`## ${kg.title}`);
            if (kg.description) lines.push(kg.description);
            lines.push('');
        }

        // Organic Results
        for (const r of (data.organic || []).slice(0, max_results)) {
            lines.push(`### ${r.title}`);
            lines.push(r.link);
            lines.push(r.snippet || '');
            lines.push('');
        }

        return lines.join('\n') || '没有找到相关结果';
    },
};

//为 Serper搜索引擎添加 web_fetch工具
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
    },
    required: ['url'],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `抓取失败: HTTP ${res.status}`;
      const html = await res.text();
      return htmlToMarkdown(html);
    } catch (err: any) {
      return `抓取失败: ${err.message}`;
    }
  },
};
// 将 HTML 转换为 Markdown 格式
const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});
turndownService.remove(['style', 'script', 'nav', 'footer', 'iframe', 'header'])
function htmlToMarkdown(html: string){

    return turndownService.turndown(html);
}

export function pickSearchTool(): ToolDefinition {
    if (process.env.TAVILY_API_KEY) return tavilySearchTool
    if (process.env.SERPER_API_KEY) return serperSearchTool
    return tavilySearchTool
}
