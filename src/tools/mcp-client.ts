import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, any>
}


export interface MCPCallResult {
  content: Array<{ type: 'text', text?: string }>,
  isError?: boolean
 }


export class MCPClient {
  private process: ChildProcess | null = null
  private requestId = 0
  private pending = new Map<number, {   // 存放待处理的请求，key 是 id，value 是 { resolve, reject }
    resolve: (value: any) => void
    reject: (reason?: any) => void
  }>();
  private serverName: string = ''
  private rl: Interface | null = null

  constructor(private command: string, private args: string[], private env?: Record<string, string>) {
    this.serverName = args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server'
  }

  async connect(): Promise<void> {
    // Windows 下 pnpm 是 .cmd 脚本，spawn 需经 shell 才能找到；
    // shell 模式须用整串命令（不传 args 数组），否则触发 DEP0190 弃用警告。
    // 命令均为固定常量，无注入风险。
    const useShell = process.platform === 'win32'
    this.process = useShell
      ? spawn([this.command, ...this.args].join(' '), {
          stdio: ['pipe', 'pipe', 'pipe'],  // 三个pipe：指的是标准输入、标准输出、标准错误输出都通过管道传递
          env: { ...process.env, ...this.env },   // 主进程环境变量传给子进程，用于访问环境变量
          shell: true,
        })
      : spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.env },
        })

    this.process.on('error', (error) => {  // 子进程错误事件
      console.error(` [MCP] 进程启动失败：${error.message}`)
    })

    // 收集 stderr，便于子进程异常退出时排查原因
    let stderrBuf = ''
    this.process.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString()
    })

    // 子进程异常退出时，立即 reject 所有 pending 请求
    // 避免子进程已死但 Promise 仍在等 stdout，最终变成 15 秒假超时
    this.process.on('exit', (code, signal) => {
      if (code === 0 && !signal) return
      const err = new Error(
        ` [MCP] 子进程异常退出 (code=${code} sig=${signal})` +
        (stderrBuf ? `\n${stderrBuf.trim().slice(-500)}` : '')
      )
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })

    this.rl = createInterface({
      input: this.process.stdout!,
    })
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) {
            p?.reject(new Error(
              ` [MCP] 错误：${msg.error.code}: ${msg.error.message}`
            ))
          } else {
            p?.resolve(msg.result)
          }
        }
      } catch (error) {
        console.error(` [MCP] 解析错误：${(error as Error).message}`)
      }
    })

    await this.send('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'super-agent', version: '0.5.0' },
    }, 60000)  // pnpm dlx 首次需下载包，预留更长时间

    this.process.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n')

  }

  private send(method: string, params?: any, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v: any) => { clearTimeout(timeout); resolve(v); },
        reject: (e: Error) => { clearTimeout(timeout); reject(e); },
      });

      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.process!.stdin!.write(msg + '\n');
    });
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.send('tools/list', {});
    return result.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result: MCPCallResult = await this.send('tools/call', { name, arguments: args });
    const texts = (result.content || [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!);
    return texts.join('\n') || '(无返回内容)';
  }

  async close(): Promise<void> {
    if (this.rl) this.rl.close();
    if (this.process) this.process.kill();
  }

}