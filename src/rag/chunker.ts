export interface Chunk {
  id: string;
  text: string;
  source: string;
  index: number;
  tokenEstimate: number;
}

const TARGET_TOKEN = 256; // 目标token数
const CHARS_PER_TOKEN = 4; // 每个token的字符数
const TARGET_CHARS = TARGET_TOKEN * CHARS_PER_TOKEN; // 目标字符数

export function chunkDocument(source: string, text: string): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);  // ['段落1', '段落2', '']
  const chunks: Chunk[] = [];
  let current = ''
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length === 0) continue

    // 缓冲区 + 新段落 > 目标字符数，先将缓冲区中的内容存起来
    if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {  // 这一段到了最大字符数
      chunks.push(makeChunk(source, current.trim(), idx++));
      current = '';
    }

    // 单个段落 > 目标字符数，按照句子分割
    if (trimmed.length > TARGET_CHARS) {  // 超长
      if (current.length > 0) {
        chunks.push(makeChunk(source, current.trim(), idx++));
        current = '';
      }

      const sentences = trimmed.split(/(?<=[。！？.!?])\s*/);
      let sentBuf = ''  // 句子缓冲区
      for (const sent of sentences) {
        if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
          chunks.push(makeChunk(source, sentBuf.trim(), idx++));
          sentBuf = '';
        }
        sentBuf += (sentBuf ? ' ' : '') + sent;
      }

      if (sentBuf.trim()) {
        current += sentBuf.trim()
      }

    } else {
      current += (current ? '\n\n' : '') + trimmed;
    }
    

  }

  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++));
  }

  return chunks;

}
function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
    tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
  }
}