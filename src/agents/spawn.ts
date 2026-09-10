import { ModelMessage, streamText } from "ai";
import { ToolRegistry } from "../tools/register";
import { SubAgentRegistry } from "./registry";
import { SpawnRequest } from "./types";
export interface SpawnContext {
    model: any;
    registry: ToolRegistry;
    agentRegistry: SubAgentRegistry;
    buildSystem: () => string;
    currentDepth: number;
}

const EXCLUDED_TOOLS = new Set(['spawn_agent']) // 不允许子Agent调用spawn_agent工具

const AGENT_COLORS = [
    '\x1b[36m',  // cyan
    '\x1b[33m',  // yellow
    '\x1b[35m',  // magenta
    '\x1b[32m',  // green
    '\x1b[34m',  // blue
];
const RESET = '\x1b[0m';
function agentTag(index: number, runId: string): string {
    const color = AGENT_COLORS[index % AGENT_COLORS.length]
    return `${color}[Agent-${index + 1}: ${runId}]${RESET}`
}
export async function spawnAgent(
    request: SpawnRequest,
    ctx: SpawnContext,
    index = 0
): Promise<string> {
    const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth)
    if (!ok) return `[spawn] 拒绝: ${reason}`

    const runId = ctx.agentRegistry.generateId()
    const tag = agentTag(index, runId)
    const run = {
        id: runId,
        task: request.task,
        status: 'running' as const,
        depth: ctx.currentDepth + 1,
        startedAt: new Date().toISOString(),
    }
    ctx.agentRegistry.register(run)

    const timeout = request.timeout || 60000
    const maxSteps = 30;
    const ac = new AbortController(); //用于取消子Agent运行
    console.log(`  ${tag}启动：${request.task.slice(0, 50)}`);

    // 关键：独立的messsage
    const messages: ModelMessage[] = [{
        role: 'user',
        content: request.task,
    }]
    try {

        const system = ctx.buildSystem() +
            '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
            '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';
        // 不能跟父Agent公用同一个agentLoop
        const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS)
        const timer = setTimeout(() => ac.abort(), timeout)  // 超时取消子Agent

        try {
            let step = 0;
            while (step < maxSteps) {
                step++;
                const isLastStep = step === maxSteps;
                console.log(`  ${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`);
                if (isLastStep) {
                    messages.push({ role: 'user', content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。' });
                }
                const result = streamText({ //子agent 向模型发请求
                    model: ctx.model, system,
                    tools,
                    toolChoice: isLastStep ? 'none' : 'auto',
                    messages,
                    maxRetries: 0, abortSignal: ac.signal,
                    providerOptions: { openai: { parallelToolCalls: true } },
                    onError: () => { },
                });
                let hasToolCall = false;
                for await (const part of result.fullStream) {
                    if (part.type === 'tool-call') {
                        hasToolCall = true;
                        const argsPreview = JSON.stringify(part.input).slice(0, 80);
                        console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
                    }
                }
                const response = await result.response;
                messages.push(...response.messages);
                if (!hasToolCall) break;
            }
        } finally {
            clearTimeout(timer);
        }
        // 提取最后一条assistant回复
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
        let result = '（无输出）'
        if (lastAssistant) {
            if (typeof lastAssistant.content === 'string') {
                result = lastAssistant.content
            } else if (Array.isArray(lastAssistant.content)) {
                result = lastAssistant.content
                    .filter((p: any) => p.type === 'text')
                    .map((p: any) => p.text)   // ['xxxx', 'yyyy']
                    .join('')
            }
        }


        ctx.agentRegistry.complete(runId, result)
        console.log(` ${tag} 完成 √ (${result.length}) 字符`);

        return result

    } catch (err: any) { //子agent执行超时，返回部分结果，避免失败
        const isAbort = err.name === 'AbortError' || ac.signal.aborted;
        const errorMsg = isAbort ? `执行超时 (${timeout / 1000}s)` : (err.message || String(err));
        ctx.agentRegistry.fail(runId, errorMsg);
        console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);
        if (isAbort) {
            const partial = [...messages].reverse().find(m => m.role === 'assistant');
            if (partial) {
                const text = typeof partial.content === 'string' ? partial.content
                    : Array.isArray(partial.content)
                        ? partial.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
                        : '';
                if (text) return `[部分结果] ${text}`;
            }
        }
        return `[sub-agent 执行失败] ${errorMsg}`;
    }


}
export async function spawnParallel(
    requests: SpawnRequest[],
    ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
    console.log(`\n  ┌─ 派发 ${requests.length} 个子 Agent 并行执行 ─┐`);
    const results = await Promise.all(  // 并行执行所有子Agent
        requests.map(async (req, i) => {
            const result = await spawnAgent(req, ctx, i);
            return { task: req.task, result };
        })
    );
    console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
    return results;
}