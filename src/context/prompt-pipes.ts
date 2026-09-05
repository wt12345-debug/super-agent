import type { MemoryStore } from '../memory/store.js';
import type { PromptContext } from './prompt-builder.js';
import type { VectorStore } from '../rag/store.js';
import type { SqliteVectorStore } from '../rag/sqlite-store.js';

// .memory 记忆系统中的上下文
export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection()   // 跟记忆系统相关的那一截提示词
}

// .rag RAG系统中的上下文
export function ragContext(vectorStore: SqliteVectorStore): (ctx: PromptContext) => string | null {
  return () => {
    const size = vectorStore.size();
    if (size === 0) return null;
    const sources = vectorStore.sources();
    return `[知识库] 已导入 ${size} 条文档片段（来源：${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  }
}