import fs from 'node:fs';
import type { CronJobConfig, RunLog } from './type';

const JOBS_FILE = '.cron/jobs.json';
const LOGS_FILE = '.cron/logs.jsonl';

export class CronStore {
  constructor(private baseDir: string = '.') {}

  private get jobsPath() { return `${this.baseDir}/${JOBS_FILE}`; }
  private get logsPath() { return `${this.baseDir}/${LOGS_FILE}`; }

  init(): void {
    const dir = `${this.baseDir}/.cron`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  loadJobs(): CronJobConfig[] {
    if (!fs.existsSync(this.jobsPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.jobsPath, 'utf-8'));
      return data.jobs || [];
    } catch {
      return [];
    }
  }

  saveJobs(jobs: CronJobConfig[]): void {
    this.init();
    fs.writeFileSync(this.jobsPath, JSON.stringify({ jobs }, null, 2));
  }

  appendLog(log: RunLog): void {
    this.init();
    fs.appendFileSync(this.logsPath, JSON.stringify(log) + '\n');
  }

  getRecentLogs(jobId?: string, limit = 10): RunLog[] {
    if (!fs.existsSync(this.logsPath)) return [];
    const lines = fs.readFileSync(this.logsPath, 'utf-8')
      .split('\n')
      .filter(Boolean);

    let logs: RunLog[] = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean) as RunLog[];

    if (jobId) logs = logs.filter(l => l.jobId === jobId);
    return logs.slice(-limit);
  }
}