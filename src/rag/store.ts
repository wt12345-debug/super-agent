import type { Chunk } from './chunker'


export interface StoredChunk extends Chunk {
    embedding: number[];
    addedAt: number;
}
export class VectorStore {
    private chunks: StoredChunk[] = []  /// 自己打造的向量数据库
    add(chunk: Chunk, embedding: number[]) {
        const existing = this.chunks.findIndex(c => c.id === chunk.id);
        if (existing >= 0) {
            this.chunks[existing] = { ...chunk, embedding, addedAt: Date.now() };
        } else {
            this.chunks.push({ ...chunk, embedding, addedAt: Date.now() });
        }
    }
    addBatch(items: Array<{ chunk: Chunk, embedding: number[] }>): void {
        for (const { chunk, embedding } of items) {
            this.add(chunk, embedding);
        }
    }
    getAll(): StoredChunk[] {
        return this.chunks;
    }

    size(): number {
        return this.chunks.length;
    }

    clear(): void {
        this.chunks = [];
    }

    sources(): string[] {
        return [...new Set(this.chunks.map(c => c.source))];
    }

}