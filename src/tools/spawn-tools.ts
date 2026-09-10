import type { ToolDefinition } from './register.js';
import type { SubAgentRegistry } from '../agents/registry.js';
import { spawnAgent, spawnParallel, type SpawnContext } from '../agents/spawn.js';

export function createSpawnTool(
    agentRegistry: SubAgentRegistry,
    getSpawnCtx: () => SpawnContext,
): ToolDefinition {
    return {
        name: 'spawn_agent',
        description: '派一个子 Agent 去执行任务。子 Agent 有独立的上下文，完成后返回结果摘要。支持同时派多个子 Agent 并行执行。',
        parameters: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: '单个任务描述（与 tasks 二选一）',
                },
                tasks: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '多个任务描述，并行执行（与 task 二选一）',
                },
            },
        },
        isConcurrencySafe: false,
        isReadOnly: true,
        execute: async (input: { task?: string; tasks?: string[] }) => {
            const ctx = getSpawnCtx();

            if (input.tasks && input.tasks.length > 0) {
                const requests = input.tasks.map(t => ({ task: t }));
                const results = await spawnParallel(requests, ctx);
                return results.map((r, i) =>
                    `## 子 Agent ${i + 1}: ${r.task.slice(0, 40)}\n\n${r.result}`
                ).join('\n\n---\n\n');
            }

            if (input.task) {
                return spawnAgent({ task: input.task }, ctx);
            }

            return '需要提供 task 或 tasks 参数';
        },
    };
}