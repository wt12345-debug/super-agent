import { mkdirSync,appendFileSync } from "node:fs";
import { dirname } from "node:path";
export interface ModelPricing {
    input: number;       // $/1M tokens (cache miss)
    output: number;
    cacheWrite: number;
    cacheRead: number;
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
    'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
    'gpt-5': { input: 1.25, output: 10.00, cacheWrite: 1.25, cacheRead: 0.125 },
    'deepseek-v4-pro': { input: 9.00, output: 27.00, cacheWrite: 1.80, cacheRead: 0.30 },
    'qwen3.8-max': { input: 2.00, output: 6.00, cacheWrite: 2.50, cacheRead: 0.25 },
    'qwen3.8-flash': { input: 0.15, output: 0.47, cacheWrite: 0.23, cacheRead: 0.018 },
    'mock-model': { input: 1.00, output: 5.00, cacheWrite: 1.25, cacheRead: 0.10 },
};
export interface UsageContext {
  provider?: string;
  providerMetadata?: any;
}
export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
}
// 把AI sdk 返回的 usage 对象规范化成 四类 token
export function normalizeUsage(usage: any, context: UsageContext = {}): StepUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  const cacheRead = usage.cachedInputTokens ?? 0;                  // AI SDK 标准字段

  const cacheWrite =
    usage.cacheCreationInputTokens                                 // Anthropic SDK 直接挂顶层
    ?? context.providerMetadata?.anthropic?.cacheCreationInputTokens // AI SDK provider 元数据
    ?? 0;

  const rawInputTokens = usage.inputTokens ?? 0;
  const inputTokens = context.provider?.startsWith('openai')
    ? Math.max(0, rawInputTokens - cacheRead)
    : rawInputTokens;

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
export function computeCost(model: string, usage: StepUsage): number {
  const p = PRICE_TABLE[model] || PRICE_TABLE['mock-model'];
  return (
    (usage.inputTokens * p.input
      + usage.outputTokens * p.output
      + usage.cacheReadTokens * p.cacheRead
      + usage.cacheWriteTokens * p.cacheWrite)
    / 1_000_000
  );
}

// 按价格表做每一步的价格计算

export class UsageTracker {
  private steps: StepRecord[] = [];
  private logPath?: string;

  constructor(logPath?: string) {
    this.logPath = logPath;
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  record(model: string, usage: StepUsage): StepRecord {  // 记录这一步的 token 用量和成本
    const cost = computeCost(model, usage);
    const record: StepRecord = { ts: Date.now(), model, cost, ...usage };
    this.steps.push(record);

    if (this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    }
    return record;
  }

  totals() {  // 计算所有 token 用量和成本
    const t = this.steps.reduce(
      (a, s) => ({
        inputTokens: a.inputTokens + s.inputTokens,
        outputTokens: a.outputTokens + s.outputTokens,
        cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
        cost: a.cost + s.cost,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    );
    const totalInputLike = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0;
    // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
    const baselineCost = (() => {
      let c = 0;
      for (const s of this.steps) {
        const p = PRICE_TABLE[s.model] || PRICE_TABLE['mock-model'];
        const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
        c += (inputLike * p.input) / 1_000_000;
        c += (s.outputTokens * p.output) / 1_000_000;
      }
      return c;
    })();
    return { ...t, hitRate, baselineCost, savedCost: baselineCost - t.cost, steps: this.steps.length };
  }

  recent(n: number): StepRecord[] {  // 获取最近 n 步的 token 用量和成本
    return this.steps.slice(-n);
  }
}