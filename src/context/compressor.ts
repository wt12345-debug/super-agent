import { generateText, type ModelMessage } from "ai";
import { textToolResultOutput, toolResultOutputToText } from "./tool-result-output";

// 计算对话历史的token数量
export function estimateTokens(messages: ModelMessage[]) {
    let chars = 0
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            chars += msg.content.length
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if ('text' in part && typeof part.text === 'string') {
                    chars += part.text.length
                } else if ('output' in part) {
                    chars += (toolResultOutputToText(part.output) as string).length
                }
            }
        }

    }

    return Math.ceil(chars / 4)
}


// 允许被压缩的工具
const CLEARABLE_TOOLS = new Set([
    'read_file', 'bash', 'grep', 'glob', 'list_directory', 'edit_file', 'write_file'
])
const KEEP_RECENT_TOOL_RESULT = 3   // 保留最近3个工具调用结果


// 只将工具调用的结果输出压缩为[tool result cleared]
export function microcompact(messages: ModelMessage[]) {
    // 找到所有工具的调用的索引位置
    const toolResultIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'tool') {
            toolResultIndices.push(i)
        }
    }

    // 保留最近3个工具调用结果
    const toClear = toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULT))

    let cleared = 0
    const result = messages.map((msg, idx) => {
        if (!toClear.includes(idx)) return msg
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg

        // 不允许压缩的工具
        const toolName = (msg.content[0] as any)?.toolName || 'unknown'
        if (!CLEARABLE_TOOLS.has(toolName)) return msg

        cleared++
        return {
            ...msg,
            content: msg.content.map((part: any) => ({
                ...part,
                output: textToolResultOutput(`[tool result cleared]`)
            }))
        }

    })

    return { messages: result, cleared }
}


// LLM摘要压缩
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的
对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

const CONTEXT_TOKEN_THRESHOLD = 300  // 如果当前对话消息开销小于300token，就不摘要
const KEEP_RECENT_MESSAGES = 6   // 保留最近6条消息的原始内容

export async function summarize(model: any, messages: ModelMessage[], existingSummary?: string) {
    const tokenEstimate = estimateTokens(messages)
    if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD || messages.length <= KEEP_RECENT_MESSAGES) {
        return { messages, summary: existingSummary || '', compressedCount: 0 }
    }

    const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES)

    let alignedIdx = splitIdx
    while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {  // 如果要摘要的数据最后一条不是用户消息，就往前多退一条
        alignedIdx--
    }
    if (alignedIdx === 0) {
        return { messages, summary: existingSummary || '', compressedCount: 0 }
    }

    const toCompress = messages.slice(0, alignedIdx)  // 要压缩的消息
    const toKeep = messages.slice(alignedIdx)  // 保留的消息

    // 将用户消息、LLM消息、工具调用结果拼接为一个字符串
    const conversationText = toCompress
        .map(msg => {
            const content = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content.map(part => 'text' in part
                        ? part.text
                        : 'output' in part
                            ? toolResultOutputToText(part.output)
                            : '').join('')
                    : '';
            return content ? `**${msg.role}**: ${content}` : '';
        })
        .filter(Boolean)
        .join('\n\n')

    if (!conversationText.trim()) {
        return { messages, summary: existingSummary || '', compressedCount: 0 }
    }

    const userPrompt = existingSummary
        ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
        : conversationText;

    try {
        const { text: summary } = await generateText({
            model,
            system: COMPRESS_PROMPT,
            prompt: userPrompt,
        })
        const summaryMessage: ModelMessage = {
            role: 'user',
            content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
        }

        const newMessages: ModelMessage[] = [summaryMessage, ...toKeep]

        return {
            messages: newMessages,
            summary,
            compressedCount: toCompress.length
        }

    } catch (error) {
        console.error('[Compaction] LLM摘要失败:', error)
        return { messages, summary: existingSummary || '', compressedCount: 0 }
    }
}