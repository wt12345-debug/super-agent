import type { ModelMessage } from 'ai'
import { toolResultOutputToText, textToolResultOutput } from './tool-result-output';


export class TokenTracker {
    private lastPreciseCount = 0;   // 上一次API返回的token用量
    private pendingChars = 0;       // 新增消息的字符数

    updateFromAPI(promptTokens: number) {
        this.lastPreciseCount = promptTokens
        this.pendingChars = 0  // 重置 
    }

    addMessage(message: ModelMessage) {
        this.pendingChars += countMessageChars(message)
    }

    addMessages(messages: ModelMessage[]) {
        for (const message of messages) {
            this.addMessage(message)
        }
    }

    replaceMessages(before: ModelMessage[], after: ModelMessage[]) {
        this.pendingChars += countMessagesChars(after) - countMessagesChars(before)
    }

    get estimateTokens(): number {
        return Math.max(0, this.lastPreciseCount + Math.ceil(this.pendingChars / 4))
    }

    get status(): { tokens: number, percent: number, needsAction: boolean } {
        const tokens = this.estimateTokens
        const percent = Math.round((tokens / CONTEXT_WINDOW) * 100)
        return {
            tokens,
            percent,
            needsAction: percent >= 75,
        }
    }

}

const CONTEXT_WINDOW = 200_000;


function countMessageChars(message: ModelMessage): number {
    let chars = 0
    if (typeof message.content === 'string') {
        return message.content.length
    }
    if (!Array.isArray(message.content)) return chars

    for (const part of message.content) {
        if ('text' in part && typeof part.text === 'string') {
            chars += part.text.length
        } else if ('output' in part) {
            chars += (toolResultOutputToText(part.output) as string).length
        } else if ('input' in part) {
            chars += JSON.stringify(part.input)?.length || 0
        }
    }

    return chars
}

function countMessagesChars(messages: ModelMessage[]): number {
    let chars = 0
    for (const message of messages) {
        chars += countMessageChars(message)
    }
    return chars
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
    const chars = countMessagesChars(messages)  // 这条消息的字符数
    return Math.ceil((chars / 4) * 1.2)  // 1.2x 中文安全系数
}



// 2 ----------------------------------

export function truncateToolResult(
    messages: ModelMessage[],
    config = {
        maxSingleResult: CONTEXT_WINDOW * 0.5 * 2,  // 50%窗口，2倍安全系数
        contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4,  // 75%窗口，4倍安全系数
    }
): { messages: ModelMessage[]; truncated: number, compacted: number } {
    let truncated = 0
    let compacted = 0

    // 1. 单条截断 -- 超过窗口50%的工具结果做 head/tail 分割
    let result = messages.map(msg => {
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

        const newContent = msg.content.map((part: any) => {
            if (!part.output) return part;
            const outputText = toolResultOutputToText(part.output) as string;
            if (outputText.length <= config.maxSingleResult) return part;

            truncated++;
            const maxChars = config.maxSingleResult;
            const headSize = Math.floor(maxChars * 0.6);
            const tailSize = Math.floor(maxChars * 0.4);
            const head = outputText.slice(0, headSize);
            const tail = outputText.slice(-tailSize);

            return {
                ...part,
                output: textToolResultOutput(`${head}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tail}`),
            };
        });

        return { ...msg, content: newContent };
    });


    // 2. 总上下文超过窗口75%， 从最老的 tool result 开始清理
    let totalChars = result.reduce((sum, msg) => {
        if (typeof msg.content === 'string') return sum + msg.content.length;
        if (Array.isArray(msg.content)) {
            return sum + (msg.content as any[]).reduce((s, p) =>
                s + (p.output ? (toolResultOutputToText(p.output) as string).length : (p.text as string)?.length || 0), 0);
        }
        return sum;
    }, 0);

    if (totalChars > config.contextBudgetChars) {
        for (let i = 0; i < result.length && totalChars > config.contextBudgetChars; i++) {
            const msg = result[i];
            if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
            const toolName = ((msg.content as any[])[0])?.toolName || 'unknown';
            const oldSize = (msg.content as any[]).reduce((s: number, p: any) =>
                s + (p.output ? (toolResultOutputToText(p.output) as string).length : 0), 0);
            result[i] = {
                ...msg,
                content: (msg.content as any[]).map((p: any) => ({
                    ...p,
                    output: textToolResultOutput(`[compacted: ${toolName} output removed to free context]`),
                })),
            };
            totalChars -= oldSize;
            compacted++;
        }
    }

    return { messages: result, truncated, compacted }
}

// 3---------------------------
export interface PruneResult {
    messages: ModelMessage[];
    softPruned: number;
    hardPruned: number;
}

interface TTLConfig {
    softTTLMs: number;
    hardTTLMs: number;
    keepHeadTail: number;
}

const DEFAULT_TTL: TTLConfig = {
    softTTLMs: 5 * 60 * 1000,
    hardTTLMs: 10 * 60 * 1000,
    keepHeadTail: 1500,
}
// 5分钟之前的工具结果做软修剪，10分钟之前的工具结果做硬修剪
export function ttlPrune(
    messages: ModelMessage[],
    timestamp: Map<number, number>,
    config: TTLConfig = DEFAULT_TTL
): PruneResult {
    const now = Date.now()
    let softPruned = 0
    let hardPruned = 0
    const result = messages.map((msg, idx) => {
        //只修剪角色为tool 的消息
        if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg

        const ts = timestamp.get(idx)  // 这条消息的 timestamp
        if (!ts) return msg  //还没出现过
        const age = now - ts

        //出错的工具调用，不修剪
        const outputText = (msg.content as any[])
            .map((p: any) => p.output ? toolResultOutputToText(p.output) as string : '')
            .join('')

        const isError = /error|失败|不存在|denied|refused|timeout/i.test(outputText)
        if (isError) return msg

        //10分钟之前的工具做硬修剪
        if (age >= config.hardTTLMs) {
            hardPruned++
            const toolName = (msg.content[0] as any)?.toolName || 'unknown'
            return {
                ...msg,
                content: (msg.content as any[]).map((p: any) => ({
                    ...p,
                    output: textToolResultOutput(`[tool result expired: ${toolName}]`),
                })),
            }
        }
        //5分钟之前的工具做软修剪
        if (age >= config.softTTLMs) {
            const newContent = msg.content.map((part: any) => {
                if (!part.output) return part
                const outputText = toolResultOutputToText(part.output) as string
                if (outputText.length <= config.keepHeadTail * 2) return part

                softPruned++;
                const head = outputText.slice(0, config.keepHeadTail)
                const tail = outputText.slice(-config.keepHeadTail)
                const removed = outputText.length - config.keepHeadTail * 2;

                return {
                    ...part,
                    output: textToolResultOutput(`${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)} min]\n\n${tail}`),
                }

            })
            return { ...msg, content: newContent }
        }
        return msg

    })
    return { messages: result, softPruned, hardPruned }
}

// 合并所有的防御手段
export interface DefenseResult {
  messages: ModelMessage[];
  tokenEstimate: number;
  truncated: number;
  compacted: number;
  softPruned: number;
  hardPruned: number;
}

export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  // Layer 2: truncate oversized tool results
  const trunc = truncateToolResult(messages);
  let result = trunc.messages;

  // Layer 3: TTL prune old tool results
  const prune = ttlPrune(result, timestamps);
  result = prune.messages;

  // Layer 1: estimate final token count
  const tokenEstimate = estimateMessageTokens(result);

  return {
    messages: result,
    tokenEstimate,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  };
}
