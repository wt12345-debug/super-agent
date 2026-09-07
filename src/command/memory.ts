import type { CommandHandler } from './index.js';

export const memoryCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/memory' && cmd !== 'memory') return false;
    const entries = ctx.memoryStore!.list();
    console.log(`\n[记忆系统] 共 ${entries.length} 条记忆`);
    for (const e of entries) console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (!cmd.startsWith('/memory search ')) return false;
    const query = cmd.slice('/memory search '.length).trim();
    const results = ctx.memoryStore!.search(query);
    console.log(`\n[记忆搜索] "${query}" → ${results.length} 条结果`);
    for (const e of results) console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log('');
    return true;
  },
  (cmd, ctx) => {
    if (cmd !== '/lint' && cmd !== 'lint') return false;
    const reports = ctx.memoryStore!.lint();
    if (reports.length === 0) {
      console.log('\n[lint] 记忆库健康，没有发现问题。\n');
      return true;
    }
    console.log(`\n[lint] 记忆库 ${reports.length} 条有警告：`);
    for (const r of reports) {
      console.log(`  📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`);
      for (const issue of r.issues) console.log(`     • ${issue.kind}: ${issue.message}`);
    }
    console.log('');
    return true;
  },
];