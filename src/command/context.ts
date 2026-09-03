import { CommandHandler } from './index'
import { buildContextSnapshot, renderContextView, renderUsageView } from '../context/view';
export const contextCommands: CommandHandler[] = [
    (cmd, ctx) => {
        if (cmd !== '/context' && cmd !== 'context') return false
        const SYSTEM = ctx.builder.build(ctx.makePromptCtx())
        const memoryChars = ctx.memoryStore?.buildPromptSection().length ?? 0
        const snapshot = buildContextSnapshot({
            modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
            modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
            windowTokens: 1_000_000,
            systemPromptChars: SYSTEM.length,
            toolDescriptionChars: ctx.registry.getActiveTools().reduce((a, t) => a + t.name.length + (t.description?.length || 0) + JSON.stringify(t.parameters || {}).length, 0),
            memoryChars,
            skillsChars: 0,
            messages: ctx.messages,
        });
        console.log(renderContextView(snapshot))
        return true
    },
    (cmd,ctx) => {
        if (cmd !== '/usage' && cmd !== 'usage') return false
        console.log(renderUsageView(ctx.tracker))
        return true
    }
]