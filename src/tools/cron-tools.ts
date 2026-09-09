import type { ToolDefinition } from './register.js';
import type { CronService } from '../cron/service.js';
import type { CronJobConfig, ScheduleType } from '../cron/type.js';

export function createCronTool(cronService: CronService): ToolDefinition {
  return {
    name: 'cron_manage',
    description: '管理定时任务。支持创建、删除、查看、立即执行定时任务。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'run', 'enable', 'disable', 'logs'],
          description: '操作类型',
        },
        id: { type: 'string', description: '任务 ID（add/remove/run/enable/disable 时必填）' },
        name: { type: 'string', description: '任务名称（add 时必填）' },
        schedule: {
          type: 'string',
          description: '调度表达式：cron("*/5 * * * *")、间隔("every 30s")、一次性(ISO 时间戳)',
        },
        prompt: { type: 'string', description: '任务执行时发送给 Agent 的 prompt（add 时必填）' },
      },
      required: ['action'],
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (input: {
      action: string;
      id?: string;
      name?: string;
      schedule?: string;
      prompt?: string;
    }) => {
      switch (input.action) {
        case 'list': {
          const jobs = cronService.list();
          if (jobs.length === 0) return '当前没有定时任务';
          return jobs.map(j => {
            const last = j.lastRun
              ? ` | 上次: ${j.lastRun.status} @ ${j.lastRun.finishedAt}`
              : '';
            return `[${j.status}] ${j.config.id} — ${j.config.name}\n  调度: ${j.config.schedule}${last}`;
          }).join('\n\n');
        }

        case 'add': {
          if (!input.id || !input.name || !input.schedule || !input.prompt) {
            return '添加任务需要: id, name, schedule, prompt';
          }
          const scheduleType: ScheduleType = input.schedule.startsWith('every') ? 'interval'
            : /^\d{4}-/.test(input.schedule) ? 'once'
            : 'cron';

          const config: CronJobConfig = {
            id: input.id,
            name: input.name,
            schedule: input.schedule,
            scheduleType,
            enabled: true,
            payload: { type: 'agent', prompt: input.prompt },
            source: 'runtime',
          };

          try {
            cronService.add(config);
            return `✓ 任务 "${input.name}" 已创建，调度: ${input.schedule}`;
          } catch (err: any) {
            return `✗ 创建失败: ${err.message}`;
          }
        }

        case 'remove': {
          if (!input.id) return '需要指定任务 id';
          const removed = cronService.remove(input.id);
          return removed ? `✓ 任务 ${input.id} 已删除` : `✗ 任务 ${input.id} 不存在`;
        }

        case 'run': {
          if (!input.id) return '需要指定任务 id';
          return cronService.runNow(input.id);
        }

        case 'enable': {
          if (!input.id) return '需要指定任务 id';
          return cronService.enable(input.id) ? `✓ 已启用` : `✗ 任务不存在`;
        }

        case 'disable': {
          if (!input.id) return '需要指定任务 id';
          return cronService.disable(input.id) ? `✓ 已禁用` : `✗ 任务不存在`;
        }

        case 'logs': {
          const logs = cronService.getRecentLogs(input.id, 5);
          if (logs.length === 0) return '暂无执行记录';
          return logs.map(l =>
            `[${l.status}] ${l.jobId} @ ${l.startedAt}\n  ${l.output?.slice(0, 100) || l.error || ''}`
          ).join('\n\n');
        }

        default:
          return `未知操作: ${input.action}`;
      }
    },
  };
}