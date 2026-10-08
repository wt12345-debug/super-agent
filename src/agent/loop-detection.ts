/**
 * Agent 工具调用死循环检测器 (Loop Detection)
 *
 * 针对大模型在自主规划与工具调用过程中容易出现的死循环模式进行识别与阻断，
 * 包括三道防线：
 * 1. 连续无进展熔断 (Global Circuit Breaker)：调用相同参数且工具持续返回相同结果，表明任务陷入停滞；
 * 2. 乒乓震荡检测 (Ping-Pong Detection)：在两个工具调用指纹间来回交替震荡 (如 A -> B -> A -> B)；
 * 3. 泛化重复调用检测 (Generic Repeat)：滑动窗口内相同参数调用频率过高。
 */

import { createHash } from 'node:crypto';

/** 循环检测器配置选项 */
export interface LoopDetectorOptions {
  /** 滑动窗口大小，记录最近 N 轮工具调用的指纹，默认 30 */
  historySize?: number;
  /** 警告阈值：达到后向大模型上下文注入系统警告，促使其切换策略，默认 5 */
  warningThreshold?: number;
  /** 严重阈值：达到后强制中断工具调用，默认 8 */
  criticalThreshold?: number;
  /** 连续无进展熔断阈值：相同输入且无进展结果连续达到该次数时强制熔断，默认 10 */
  breakerThreshold?: number;
}

/** 单次工具调用记录 */
export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

/** 检测器类型 */
export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

/** 检测结果 */
export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

/**
 * 确定性/稳定序列化 (Stable Stringify)
 *
 * 保证相同内容的参数对象无论对象 key 顺序如何、是否存在嵌套，都能生成一致的序列化文本。
 * 内置循环引用防护（通过 WeakSet 跟踪），避免深层递归爆栈。
 */
export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') {
      return `${value.toString()}n`;
    }
    if (typeof value === 'undefined') {
      return 'undefined';
    }
    return JSON.stringify(value);
  }

  // 防止循环引用导致栈溢出
  if (seen.has(value)) {
    return '"[Circular]"';
  }
  seen.add(value);

  // 针对 Date 类型的稳定处理
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  // 针对 RegExp 类型的处理
  if (value instanceof RegExp) {
    return JSON.stringify(value.toString());
  }

  // 针对 Error 对象的规范化处理
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
    });
  }

  // 数组序列化（递归处理每个元素）
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item, seen)).join(',')}]`;
  }

  // 对象序列化：键名排序保证输出稳定性，忽略 undefined 属性
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const serializedEntries: string[] = [];

  for (const k of keys) {
    const val = record[k];
    if (val !== undefined) {
      serializedEntries.push(`${JSON.stringify(k)}:${stableStringify(val, seen)}`);
    }
  }

  return `{${serializedEntries.join(',')}}`;
}

/**
 * 计算输入的 SHA-256 哈希值前 16 位十六进制字符作为紧凑指纹
 */
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 为工具名称与其参数生成稳定指纹
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

/**
 * 为工具执行结果生成稳定指纹
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

/**
 * 循环检测器类
 * 支持独立实例（适用于多 Agent 或并发子 Agent 场景），也可使用默认导出的全局单例。
 */
export class LoopDetector {
  public readonly historySize: number;
  public readonly warningThreshold: number;
  public readonly criticalThreshold: number;
  public readonly breakerThreshold: number;

  private history: ToolCallRecord[] = [];

  constructor(options: LoopDetectorOptions = {}) {
    this.historySize = options.historySize ?? 30;
    this.warningThreshold = options.warningThreshold ?? 5;
    this.criticalThreshold = options.criticalThreshold ?? 8;
    this.breakerThreshold = options.breakerThreshold ?? 10;
  }

  /**
   * 记录一次工具调用的发生
   */
  public recordCall(toolName: string, params: unknown): void {
    this.history.push({
      toolName,
      argsHash: hashToolCall(toolName, params),
      timestamp: Date.now(),
    });

    // 维持滑动窗口上限
    while (this.history.length > this.historySize) {
      this.history.shift();
    }
  }

  /**
   * 记录工具调用的执行结果
   * 从后往前匹配最近一次尚未绑定结果的相同工具与参数调用记录
   */
  public recordResult(toolName: string, params: unknown, result: unknown): void {
    const argsHash = hashToolCall(toolName, params);
    const resultH = hashResult(result);

    for (let i = this.history.length - 1; i >= 0; i--) {
      const record = this.history[i];
      if (record.toolName === toolName && record.argsHash === argsHash && !record.resultHash) {
        record.resultHash = resultH;
        break;
      }
    }
  }

  /**
   * 重置调用历史
   */
  public resetHistory(): void {
    this.history.length = 0;
  }

  /**
   * 获取当前滑动窗口的历史记录拷贝
   */
  public getHistory(): readonly ToolCallRecord[] {
    return [...this.history];
  }

  /**
   * 防线一：统计连续相同调用产生完全相同结果的次数（无进展停滞）
   */
  private getNoProgressStreak(toolName: string, argsHash: string): number {
    let streak = 0;
    let lastResultHash: string | undefined;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const r = this.history[i];
      if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
      if (!r.resultHash) continue;

      if (!lastResultHash) {
        lastResultHash = r.resultHash;
        streak = 1;
        continue;
      }

      // 如果结果发生变化，说明有了新进展，中断连续计数
      if (r.resultHash !== lastResultHash) break;
      streak++;
    }

    return streak;
  }

  /**
   * 防线二：乒乓交替循环检测 (A -> B -> A -> B ...)
   * 检查历史末尾是否在两个指纹之间规律交替，且当前调用是否符合该交替序列。
   */
  private getPingPongCount(currentHash: string): number {
    if (this.history.length < 2) return 0;

    const last = this.history[this.history.length - 1];
    let otherHash: string | undefined;

    // 倒序寻找与末尾记录不同的另一个指纹
    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.history[i].argsHash !== last.argsHash) {
        otherHash = this.history[i].argsHash;
        break;
      }
    }

    if (!otherHash) return 0;

    // 计算历史末尾按照 last 和 otherHash 交替出现的连续次数
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const expected = count % 2 === 0 ? last.argsHash : otherHash;
      if (this.history[i].argsHash !== expected) break;
      count++;
    }

    // 若当前即将调用的参数与期望的下一个交替指纹一致，则乒乓步数加 1
    if (currentHash === otherHash && count >= 2) {
      return count + 1;
    }

    return 0;
  }

  /**
   * 主检测函数：在执行工具前调用，评估是否陷入死循环
   *
   * 优先级：连续无进展熔断 > 乒乓循环 > 泛化重复调用
   */
  public detect(toolName: string, params: unknown): DetectionResult {
    const argsHash = hashToolCall(toolName, params);

    // 1. 无进展熔断检测
    const noProgress = this.getNoProgressStreak(toolName, argsHash);
    if (noProgress >= this.breakerThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'global_circuit_breaker',
        count: noProgress,
        message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
      };
    }

    // 2. 乒乓交替检测
    const pingPong = this.getPingPongCount(argsHash);
    if (pingPong >= this.criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'ping_pong',
        count: pingPong,
        message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
      };
    }
    if (pingPong >= this.warningThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'ping_pong',
        count: pingPong,
        message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
      };
    }

    // 3. 泛化相同参数调用统计
    const recentCount = this.history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
    if (recentCount >= this.criticalThreshold) {
      return {
        stuck: true,
        level: 'critical',
        detector: 'generic_repeat',
        count: recentCount,
        message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
      };
    }
    if (recentCount >= this.warningThreshold) {
      return {
        stuck: true,
        level: 'warning',
        detector: 'generic_repeat',
        count: recentCount,
        message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
      };
    }

    return { stuck: false };
  }
}

// 全局默认单例，保持原有函数式 API 的兼容性
const defaultDetector = new LoopDetector();

export function recordCall(toolName: string, params: unknown): void {
  defaultDetector.recordCall(toolName, params);
}

export function recordResult(toolName: string, params: unknown, result: unknown): void {
  defaultDetector.recordResult(toolName, params, result);
}

export function resetHistory(): void {
  defaultDetector.resetHistory();
}

export function detect(toolName: string, params: unknown): DetectionResult {
  return defaultDetector.detect(toolName, params);
}