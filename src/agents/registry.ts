/**
 * 一个简单的注册表
 * 记录谁在跑
 * 跑到哪里了
 * 结果是什么
 */
import type { SubAgentRun, SubAgentConfig } from './types';
import { DEFAULT_CONFUG } from './types';

export class SubAgentRegistry {
    private runs = new Map<string, SubAgentRun>();
    private config: SubAgentConfig = DEFAULT_CONFUG;
    private idCounter = 0;
    constructor(config?: Partial<SubAgentConfig>) {
        this.config = { ...DEFAULT_CONFUG, ...config };
    }
    generateId(): string {
        return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`
    }
    canSpawn(currentDepth: number): { ok: boolean, reason?: string } {
        if (currentDepth >= this.config.maxSpawnDepth) {
            return { ok: false, reason: `已达到最大嵌套深度 ${this.config.maxSpawnDepth}` }
        }
        const activeCount = this.getActiveRuns().length;
        if (activeCount >= this.config.maxConcurrent) {
            return { ok: false, reason: `已达到最大并行子Agent数 ${this.config.maxConcurrent}` }
        }
        return { ok: true }
    }
    register(run: SubAgentRun) {
        this.runs.set(run.id, run);
    }
    complete(id: string, result: string): void {  // 强行完成一个子Agent
        const run = this.runs.get(id)
        if (!run) return
        run.status = 'completed'
        run.finishedAt = new Date().toISOString()
        run.result = result
    }
    fail(id: string, error: string): void {  // 强行失败一个子Agent
        const run = this.runs.get(id)
        if (!run) return
        run.status = 'error'
        run.finishedAt = new Date().toISOString()
        run.error = error
    }
    get(id: string): SubAgentRun | undefined {
        return this.runs.get(id)
    }
    getActiveRuns(): SubAgentRun[] {
        return [...this.runs.values()].filter(r => r.status === 'running')
    }
    getAllRuns(): SubAgentRun[] {
        return Array.from(this.runs.values())
    }

    getConfig(): SubAgentConfig {
        return this.config
    }
}
