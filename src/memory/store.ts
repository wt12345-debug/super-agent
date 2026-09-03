
/**
 * 优化记忆存储 -- 不能每次都加载所有记忆
 * 提取有效记忆的手段：文件 xxx.md | RAG
 * xxx.md --- 专门用一个markdown文件来提取有效记忆
 */

// ---
// name: 用户偏好 Typescript
// description: 用户对Typescript的偏好, 不喜欢 python
// type: user
// ---

import fs from 'node:fs';
import path from 'node:path';

export interface MemoryEntry {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  content: string;
  filePath: string;
}

const MEMORY_DIR = '.memory';  // 默认记忆目录名
const INDEX_FILE = 'MEMORY.md';  // 默认记忆引文件名 === 一个 skill 文件
const MAX_INDEX_LINES = 200;   // 一个索引文件最多200行
const MAX_FILE_CHARS = 4000;   // 单个记忆文件最多4000个字符

export class MemoryStore {
  private readonly baseDir: string = '.'

  constructor(baseDir: string = '.') {
    this.baseDir = baseDir
  }

  private get memoryDir() {
    return path.join(this.baseDir, MEMORY_DIR)
  }

  private get indexPath() {
    return path.join(this.memoryDir, INDEX_FILE)
  }

  init() {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, '# Memory Index\n', 'utf-8')
    }
  }

  // 将有效记忆保存到文件，文件以 skill 的格式开头，然后拼接 有效的记忆内容
  save(entry: Omit<MemoryEntry, 'filePath'>): string {
    this.init();
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '');
    const filename = `${entry.type}_${slug}.md`;
    const filePath = path.join(this.memoryDir, filename);

    const fileContent = [
      '---',
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      '---',
      '',
      entry.content,
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    this.updateIndex(entry.name, filename, entry.description);
    return filename;
  }

  // 更新索引文件，判断记忆文件中的内容是否超过最大字符数
  private updateIndex(name: string, filename: string, description: string): void {
    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = indexContent.split('\n');

    const existingIdx = lines.findIndex(l => l.includes(`(${filename})`));
    const newLine = `- [${name}](${filename}) — ${description}`;

    if (existingIdx >= 0) {
      lines[existingIdx] = newLine;
    } else {
      if (lines.length >= MAX_INDEX_LINES) {
        console.log(`[memory] 索引已达 ${MAX_INDEX_LINES} 行上限，移除最早的条目`);
        const firstEntry = lines.findIndex(l => l.startsWith('- '));
        if (firstEntry >= 0) lines.splice(firstEntry, 1);
      }
      lines.push(newLine);
    }

    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
  }

  // 从记忆文件中读取所有有效记忆
  list(): MemoryEntry[] {
    this.init();
    const entries: MemoryEntry[] = [];  // 所有的记忆文件的头部信息
    const files = fs.readdirSync(this.memoryDir)
      .filter(f => f.endsWith('.md') && f !== INDEX_FILE);

    for (const file of files) {
      const filePath = path.join(this.memoryDir, file);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (parsed) {
        entries.push({ ...parsed, filePath });
      }
    }
    return entries;
  }

  // 拿着关键词，在所有有效记忆文件的头部信息中搜索，返回所有匹配的记录
  search(query: string): MemoryEntry[] {
    const all = this.list();
    const keywords = query.toLowerCase().split(/\s+/);
    return all.filter(entry => {
      const text = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
  }

  // 读取记忆文件中的内容
  loadIndex(): string {
    this.init();
    const raw = fs.readFileSync(this.indexPath, 'utf-8');
    return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
  }

  // 读取指定文件中的内容
  loadFile(filename: string): string | null {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(已截断)' : raw;
  }

  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);  // 删除记忆文件

    const indexContent = fs.readFileSync(this.indexPath, 'utf-8');
    const lines = indexContent.split('\n').filter(l => !l.includes(`(${filename})`));
    fs.writeFileSync(this.indexPath, lines.join('\n'), 'utf-8');
    return true;
  }

  buildPromptSection(): string {
    this.init();
    const index = this.loadIndex();
    const entries = this.list();

    if (entries.length === 0) {
      return '[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。';
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      '',
      '记忆索引：',
      index,
      '',
      '使用 memory 工具的 read 操作来读取具体记忆内容。',
      '记忆是线索，不是事实——使用前先验证其准确性。',
    ];
    return lines.join('\n');
  }

  private parseFrontmatter(raw: string): Omit<MemoryEntry, 'filePath'> | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const validTypes = ['user', 'feedback', 'project', 'reference'];
    if (!meta.name || !meta.type || !validTypes.includes(meta.type)) return null;

    return {
      name: meta.name,
      description: meta.description || '',
      type: meta.type as MemoryEntry['type'],
      content: match[2].trim(),
    };
  }

}