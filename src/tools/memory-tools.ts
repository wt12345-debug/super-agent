import type { MemoryStore } from '../memory/store.js';
import type { ToolDefinition } from './register.js';

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description: '管理跨会话记忆。action: save | list | search | read | delete | lint。read/delete 需要 filename（如 project_xxx.md）；save 同名自动覆盖；lint 结果自带内容预览，不需要逐条 read',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'search', 'read', 'delete', 'lint'] },
        name: { type: 'string', description: '记忆名称（save 时必填）' },
        description: { type: 'string', description: '一句话描述（save 时必填）' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: '记忆类型（save 时必填）' },
        content: { type: 'string', description: '记忆内容（save 时必填）' },
        query: { type: 'string', description: '搜索关键词（search 时必填）' },
        filename: { type: 'string', description: '文件名（read/delete 时必填）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      switch (args.action) {
        case 'save': {
          if (!args.name || !args.type || !args.content) {
            return '保存失败：需要 name、type、content 参数';
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          });
          return `已保存到记忆: ${filename}`;
        }
        case 'list': {
          const entries = memoryStore.list();
          if (entries.length === 0) return '当前没有存储任何记忆。';
          return `记忆列表（共 ${entries.length} 条记忆）：\n` +
            entries.map(e => `  [${e.type}] ${e.name} — ${e.description}`).join('\n');
        }
        case 'search': {
          const results = memoryStore.search(args.query || '');
          if (results.length === 0) return `没有找到与 "${args.query}" 相关的记忆。`;
          return `搜索结果（${results.length} 条匹配）：\n` +
            results.map(e => `  [${e.type}] ${e.name} — ${e.description}`).join('\n');
        }
        case 'read': {
          if (!args.filename) return '读取失败：需要 filename 参数';
          return memoryStore.loadFile(args.filename) ?? `文件不存在: ${args.filename}`;
        }
        case 'delete': {
          if (!args.filename) return '删除失败：需要 filename 参数';
          return memoryStore.delete(args.filename) ? `已删除: ${args.filename}` : `文件不存在: ${args.filename}`;
        }
        case 'lint': {
          const reports = memoryStore.lint();
          if (reports.length === 0) return '记忆库健康，没有发现问题。';
          const lines = [`记忆库 lint 报告（${reports.length} 条有问题）：`, ''];
          for (const r of reports) {
            const fname = r.entry.filePath.split('/').pop();
            const preview = r.entry.content.slice(0, 100).replace(/\n/g, ' ');
            lines.push(`📁 ${fname}  [${r.entry.type}] ${r.entry.name}`);
            lines.push(`   内容预览: ${preview}${r.entry.content.length > 100 ? '...' : ''}`);
            for (const issue of r.issues) lines.push(`   • ${issue.kind}: ${issue.message}`);
            lines.push('');
          }
          lines.push('提示: 基于以上报告直接操作即可（delete 删除、save 覆盖更新），不需要逐条 read。');
          return lines.join('\n');
        }
        default:
          return `未知操作: ${args.action}`;
      }
    },
  };
}