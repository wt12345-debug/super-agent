export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

const DIMS = 128 // 嵌入维度;

export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
  return async (texts: string[]) => {
    const resp = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-v3',
          input: texts,
          dimensions: DIMS,
        }),
      },
    );
    const data = await resp.json() as any;
    return data.data.map((d: any) => d.embedding as number[]);
  };
}

// 相同的文本没必要重复做向量处理
const embedCache = new Map<string, number[]>();
.0
export async function embed(fn: EmbeddingFn, texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  const uncached: { idx: number; text: string }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ idx: i, text: texts[i] });
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map(u => u.text));  // 批量处理未缓存的文本
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i].idx] = vectors[i];
      embedCache.set(uncached[i].text, vectors[i]);
    }
  }

  return results;
}

// 计算向量之间的余弦相似度  --- 两个向量“有多像”
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export { DIMS };