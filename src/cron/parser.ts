import { Cron } from 'croner';
import type { ScheduleType } from './type';

export interface ParsedSchedule {
  type: ScheduleType;
  intervalMs?: number;       // interval 类型：固定间隔毫秒数
  cronInstance?: Cron;       // cron 类型：croner 实例，负责计算下次执行时间
  onceAt?: Date;             // once 类型：一次性执行的目标时间
}

const INTERVAL_RE = /^every\s+(\d+)\s*(s|sec|m|min|h|hour)s?$/i;

export function parseSchedule(expr: string): ParsedSchedule {
  // 固定间隔
  const intervalMatch = expr.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    const multiplier = unit.startsWith('h') ? 3600000
      : unit.startsWith('m') ? 60000
      : 1000;
    return { type: 'interval', intervalMs: value * multiplier };
  }

  // ISO 时间戳
  if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const date = new Date(expr);
    if (!isNaN(date.getTime())) {
      return { type: 'once', onceAt: date };
    }
  }

  // Cron 表达式
  const cronInstance = new Cron(expr);
  return { type: 'cron', cronInstance };
}

export function getNextCronTime(cron: Cron): number {
  return cron.msToNext() ?? 60000;
}