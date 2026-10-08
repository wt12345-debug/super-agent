/**
 * Token 用量与成本核算模块
 *
 * 职责：
 *  1. normalizeUsage —— 把各家 provider（OpenAI / Anthropic / ...）形态各异的 usage
 *     统一成「四类 token」：普通输入、输出、缓存读、缓存写。
 *  2. computeCost —— 按价格表把四类 token 折算成美元。
 *  3. UsageTracker —— 逐步累计用量与成本，可选落盘 JSONL，供 /usage 视图读取。
 *
 * 两条贯穿全文件的约定：
 *  - 价格单位一律是「美元 / 100 万 token」，与各家官网标价同单位，避免手工换算出错。
 *  - 命中缓存的输入一定比 cache miss 便宜，所以必须把 cacheRead 从普通输入里拆出来
 *    单独计价，否则成本会被系统性高估。
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

/** 单个模型的价格（单位：美元 / 100 万 token） */
export interface ModelPricing {
  /** 普通输入（cache miss） */
  input: number;
  /** 输出 */
  output: number;
  /** 写入缓存 */
  cacheWrite: number;
  /** 命中缓存 */
  cacheRead: number;
}

/**
 * 价格表，key 为模型 ID。
 * 查找时走「精确命中 -> 去掉 provider 前缀 -> 最长前缀」三级匹配，
 * 所以 gpt-5-2025-08-07、openai/gpt-5 这类写法都能自动落到 gpt-5 的价位，
 * 不必为每个快照名单独登记一行。
 */
export const PRICE_TABLE: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  "gpt-5": { input: 1.25, output: 10.0, cacheWrite: 1.25, cacheRead: 0.125 },
  "deepseek-v4-pro": { input: 9.0, output: 27.0, cacheWrite: 1.8, cacheRead: 0.3 },
  "qwen3.8-max": { input: 2.0, output: 6.0, cacheWrite: 2.5, cacheRead: 0.25 },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cacheWrite: 0.23, cacheRead: 0.018 },
  "mock-model": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * 未知模型的兜底价格。
 * 只是借用 mock-model 的价位给出一个数量级参考，并不代表真实账单，
 * 因此 resolvePricing 会一并返回 matched=false，上层可据此提示用户补价格表。
 */
const FALLBACK_PRICING: ModelPricing = PRICE_TABLE["mock-model"];

/** 前缀匹配时，模型名在前缀之后必须紧跟这些分隔符，避免 gpt-50 误命中 gpt-5 */
const NAME_SEPARATORS = "-._:/@";

/** 调用方补充的上下文，用于抹平不同 provider 的字段差异 */
export interface UsageContext {
  /** 供应商标识（如 openai / anthropic），决定 inputTokens 是否已包含缓存部分 */
  provider?: string;
  /** AI SDK 透传的 provider 原始元数据（Anthropic 的缓存写入量藏在这里） */
  providerMetadata?: unknown;
}

/** 四类 token，模块内部统一使用这个形状 */
export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 单步记录 = 用量 + 归属模型 + 成本 + 时间戳 */
export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
}

/** 累计结果，即 /usage 视图所需的全部数据 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 实付成本（缓存命中已按折扣价计算） */
  cost: number;
  /** 缓存命中率 = cacheRead / 全部 input-like token */
  hitRate: number;
  /** 假想成本：假设一次缓存都没命中，全部 input-like token 按原价计费 */
  baselineCost: number;
  /** 因缓存省下的钱 = baselineCost - cost */
  savedCost: number;
  /** 累计步数 */
  steps: number;
}

/**
 * AI SDK usage 对象的最小结构声明。
 * 字段全部可选，以兼容不同版本、以及只上报部分字段的自研 provider。
 */
export interface RawUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** 命中缓存的输入（部分版本在顶层直接给出） */
  cachedInputTokens?: number | undefined;
  /** Anthropic 风格：直接挂在顶层的缓存写入量 */
  cacheCreationInputTokens?: number | undefined;
  /** AI SDK 新版明细，语义最准确，优先使用 */
  inputTokenDetails?: {
    noCacheTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
}

/** 四类 token 全为零的常量，用作空值返回（浅拷贝后再返回，避免被调用方改写） */
const EMPTY_USAGE: StepUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 从 providerMetadata 中读出 Anthropic 的缓存写入量，取不到就是 0 */
function readAnthropicCacheWrite(metadata: unknown): number {
  const anthropic = (metadata as { anthropic?: { cacheCreationInputTokens?: number } } | null | undefined)?.anthropic;
  return anthropic?.cacheCreationInputTokens ?? 0;
}

/**
 * 把 AI SDK 返回的 usage 规范化为四类 token。
 *
 * 两条路径：
 *  - 优先路径：存在 inputTokenDetails 时直接采用。SDK 已经把 total / noCache /
 *    cacheRead / cacheWrite 拆好，且各家 provider 差异已在 SDK 层抹平，无需再猜。
 *  - 兜底路径：只有扁平字段时，靠 provider 判断 inputTokens 是否已包含缓存部分。
 */
export function normalizeUsage(usage: RawUsage | null | undefined, context: UsageContext = {}): StepUsage {
  if (!usage) return { ...EMPTY_USAGE };

  const outputTokens = usage.outputTokens ?? 0;

  // ── 优先路径：SDK 已给出拆分好的明细 ──────────────────────────────
  const details = usage.inputTokenDetails;
  if (details) {
    const cacheReadTokens = details.cacheReadTokens ?? 0;
    const cacheWriteTokens = details.cacheWriteTokens ?? 0;
    // noCacheTokens 缺失时，退化成「总输入 - 缓存读」，避免把缓存部分重复计入原价
    const inputTokens = details.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheReadTokens);
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  }

  // ── 兜底路径：老版本 SDK / 只上报扁平字段的 provider ───────────────
  const cacheReadTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheCreationInputTokens ?? readAnthropicCacheWrite(context.providerMetadata);
  const rawInputTokens = usage.inputTokens ?? 0;

  // OpenAI 的 inputTokens 已把 cached 部分算在内，直接相加会重复计价，故做减法；
  // Anthropic 的 input_tokens 本身不含 cache，保持原值。
  const fromOpenAI = (context.provider ?? "").toLowerCase().startsWith("openai");
  const inputTokens = fromOpenAI ? Math.max(0, rawInputTokens - cacheReadTokens) : rawInputTokens;

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** 按价格把四类 token 折算成美元 */
function costOf(pricing: ModelPricing, usage: StepUsage): number {
  const perMillion =
    usage.inputTokens * pricing.input +
    usage.outputTokens * pricing.output +
    usage.cacheReadTokens * pricing.cacheRead +
    usage.cacheWriteTokens * pricing.cacheWrite;
  return perMillion / 1_000_000;
}

/**
 * 三级价格查找：精确命中 -> 去掉 provider 前缀（openai/gpt-5）-> 最长前缀（gpt-5-2025-08-07）。
 * matched=false 表示最终落到兜底价，成本数字仅供参考。
 */
export function resolvePricing(model: string): { pricing: ModelPricing; matched: boolean } {
  const exact = PRICE_TABLE[model];
  if (exact) return { pricing: exact, matched: true };

  // openai/gpt-5 之类带 provider 前缀的写法，取最后一段再查一次
  const slash = model.lastIndexOf("/");
  const name = slash >= 0 ? model.slice(slash + 1) : model;
  const exactByName = PRICE_TABLE[name];
  if (exactByName) return { pricing: exactByName, matched: true };

  // 最长前缀匹配：gpt-5-2025-08-07 -> gpt-5
  let best: ModelPricing | undefined;
  let bestLength = 0;
  for (const [key, pricing] of Object.entries(PRICE_TABLE)) {
    if (key.length <= bestLength || !name.startsWith(key)) continue;
    const next = name[key.length];
    if (next !== undefined && !NAME_SEPARATORS.includes(next)) continue;
    best = pricing;
    bestLength = key.length;
  }

  return best ? { pricing: best, matched: true } : { pricing: FALLBACK_PRICING, matched: false };
}

/** 计算单步成本；模型未登记时按兜底价估算 */
export function computeCost(model: string, usage: StepUsage): number {
  return costOf(resolvePricing(model).pricing, usage);
}

/** 逐步骤累计用量与成本，可选把每一步追加写入 JSONL 日志 */
export class UsageTracker {
  private steps: StepRecord[] = [];
  private readonly logPath?: string;

  constructor(logPath?: string) {
    this.logPath = logPath;
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  /** 记录一步的 token 用量与成本；配置了 logPath 时同步追加一行 JSONL */
  record(model: string, usage: StepUsage): StepRecord {
    const record: StepRecord = { ts: Date.now(), model, cost: computeCost(model, usage), ...usage };
    this.steps.push(record);

    if (this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(record) + "\n");
    }
    return record;
  }

  /** 汇总全部步骤：四类 token、实付成本、缓存命中率，以及缓存省下的钱 */
  totals(): UsageTotals {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cost = 0;
    let baselineCost = 0;

    for (const step of this.steps) {
      inputTokens += step.inputTokens;
      outputTokens += step.outputTokens;
      cacheReadTokens += step.cacheReadTokens;
      cacheWriteTokens += step.cacheWriteTokens;
      cost += step.cost;

      // baseline 用该步自己的价格重算，而不是复用 step.cost：
      // 把全部 input-like token 按 miss 原价计费，才能算出缓存究竟省了多少。
      const pricing = resolvePricing(step.model).pricing;
      const inputLike = step.inputTokens + step.cacheReadTokens + step.cacheWriteTokens;
      baselineCost += costOf(pricing, {
        inputTokens: inputLike,
        outputTokens: step.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }

    const inputLikeTotal = inputTokens + cacheReadTokens + cacheWriteTokens;
    const hitRate = inputLikeTotal > 0 ? cacheReadTokens / inputLikeTotal : 0;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      hitRate,
      baselineCost,
      savedCost: baselineCost - cost,
      steps: this.steps.length,
    };
  }

  /** 取最近 n 步记录；n 非法或 <= 0 时返回空数组 */
  recent(n: number): StepRecord[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    return this.steps.slice(-n);
  }
}
