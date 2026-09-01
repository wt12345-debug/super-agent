import type { ToolDefinition } from './register'
import fg from 'fast-glob'
import { join, resolve,relative } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'


//全局搜索
export const globTool: ToolDefinition = {
    name: 'glob',
    description: '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: '搜索模式，如 "**/*.ts"、"src/*.json"' },
            path: { type: 'string', description: '搜索起始目录，默认当前目录' },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
        const results = await fg(pattern, {
            cwd: resolve(path),
            ignore: ['node_modules/**', '.git/**'],
            dot: false,
            onlyFiles: true,
            followSymbolicLinks: false,
        });
        if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
        return results.sort().join('\n');
    },
};

// Grep 精准查找
export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: { type: 'string', description: '搜索路径（文件或目录），默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ pattern, path = '.' }: { pattern: string; path?: string }) => {
    const baseDir = resolve(path);
    const regex = new RegExp(pattern, 'i');
    const matches: string[] = [];
    const SKIP = new Set(['node_modules', '.git', 'dist']);
    const BIN_EXT = new Set(['.png', '.jpg', '.gif', '.woff', '.woff2', '.ico', '.lock']);

    function searchFile(filePath: string) {
      if (matches.length >= 50) return;
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      if (BIN_EXT.has(ext)) return;

      let content: string;
      try { content = readFileSync(filePath, 'utf-8'); } catch { return; }

      const lines = content.split('\n');
      const rel = relative(baseDir, filePath);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (matches.length >= 50) return;
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }

      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else searchFile(full);
        } catch { /* skip */ }
      }
    }

    const stat = statSync(baseDir);
    if (stat.isFile()) {
      searchFile(baseDir);
    } else {
      walk(baseDir);
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix = matches.length >= 50 ? '\n... (结果已截断，共 50+ 条匹配)' : '';
    return matches.join('\n') + suffix;
  },
};