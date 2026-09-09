export type ScheduleType = 'cron' | 'interval' | 'once';

export interface CronJobConfig {
  id: string;                 // 任务唯一标识
  name: string;               // 任务显示名称
  description?: string;       // 可选的任务描述
  schedule: string;           // 调度表达式：cron 五字段 | "every 30s" | ISO 时间戳
  scheduleType: ScheduleType; // 解析后的调度类型
  enabled: boolean;           // 是否启用
  payload: JobPayload;        // 执行内容（agent prompt 或 handler 回调）
  timeout?: number;           // 单次执行超时，单位 ms，默认 60000
  maxRetries?: number;        // 连续失败多少次后自动禁用，默认 3
  source: 'config' | 'runtime'; // 来源：config 不可删，runtime 可增删
}

export type JobPayload =
  | { type: 'agent'; prompt: string }    // 把 prompt 交给 Agent Loop 执行
  | { type: 'handler'; handler: string }; // 调用插件注册的 handler 函数

export interface RunLog {
  jobId: string;              // 所属任务 ID
  startedAt: string;          // 开始时间 ISO 字符串
  finishedAt: string;         // 结束时间 ISO 字符串
  status: 'success' | 'error' | 'timeout'; // 执行结果
  output?: string;            // 执行输出（截断到 1000 字符）
  error?: string;             // 错误信息
}

export interface CronJobState {
  config: CronJobConfig;      // 任务配置
  timerId: ReturnType<typeof setTimeout> | null; // 当前定时器句柄
  lastRun?: RunLog;           // 上一次执行记录
  consecutiveFailures: number; // 连续失败计数
  running: boolean;           // 是否正在执行中
}