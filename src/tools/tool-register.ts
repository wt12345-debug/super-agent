import { jsonSchema } from 'ai'
import type { MCPClient } from './mcp-client'
export interface ToolDefinition {
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (input: any) => Promise<any>

    isConcurrencySafe?: boolean, //能否并行
    isReadOnly?: boolean,  //是否只读
    maxResultChars?: number, //最大结果字符数
}
const DEFAULT_MAX_RESULT_CHARS = 3000 //工具执行允许的最大输出字符数


export class ToolRegistry {
    private tools = new Map<string, ToolDefinition>() //工具列表
    private mcpClients: MCPClient[] = []  // 存放正在连接的 MCP 服务器


    // 用三个状态变量来构成一把锁
    private exclusiveLock = false;  //当前是否有独占锁的持有者
    private concurrentCount = 0; //当前共享锁的持有者数量
    private waitQueue: Array<() => void> = [] // 等待队列，阻塞等待中的 resolve 函数
    register(...tools: ToolDefinition[]): void {// 将来在任何地方定义的工具，都直接通过register方法注册，被存入tools Map工具列表
        for (const tool of tools) {
            this.tools.set(tool.name, tool)
        }
    }

    async registerMCPServer(serverName: string, client: MCPClient): Promise<string[]> {   // 注册 MCP 服务中的工具
    await client.connect()  // 连接 MCP 服务器
    this.mcpClients.push(client)  // 存储 MCP 服务器连接
 
    const tools = await client.listTools()  // 获取 MCP 服务器中的工具列表
    const registered: string[] = []
    
    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`
      if (this.tools.has(prefixedName)) continue

      const toolClient = client
      const originalName = tool.name

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input)
        },
      })

      registered.push(prefixedName)  
    }

    return registered
  }
    async closeAllMCP(): Promise<void> {  // 关闭所有 MCP 服务器连接
    for (const client of this.mcpClients) {
      await client.close()
    }
    this.mcpClients = []
  }
    get(name: string) {// 根据工具名称获取工具定义
        return this.tools.get(name)
    }
    getAll(): ToolDefinition[] {
        return [...this.tools.values()]
    }
    //获取共享锁
    private async acquireConcurrent() :Promise<void>{
        while(this.exclusiveLock){
            await new Promise<void>(resolve => this.waitQueue.push(resolve))
        }
        this.concurrentCount++
    }
    //释放共享锁
    private releaseConcurrent():void{
        this.concurrentCount--
        if(this.concurrentCount === 0)this.drainQueue(); // 释放共享锁后，检查是否有等待中的 resolve 函数
       
    }
    //获取独占锁
    private async acquireExclusive() :Promise<void>{
        while(this.exclusiveLock || this.concurrentCount > 0){ //当有独占锁或共享锁时，等待队列中添加 resolve 函数，阻塞等待
            await new Promise<void>(resolve => this.waitQueue.push(resolve)) 
        }
        this.exclusiveLock = true
    }
    //释放独占锁
    private releaseExclusive():void{
        this.exclusiveLock = false
        this.drainQueue(); // 释放独占锁后，检查是否有等待中的 resolve 函数
    }
    //锁释放时，把等待队列中的 resolve 全部唤醒，让他们重新去抢锁
    private drainQueue():void{
        const waiting = this.waitQueue.splice(0)
        for(const resolve of waiting){
            resolve()
        }
        
    }

    toAISDKFormat(): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [name, tool] of this.tools) {
            const maxChars = tool.maxResultChars;
            const executeFn = tool.execute;
            const isSafe = tool.isConcurrencySafe === true;
            const registry = this;
            result[name] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: async (input: any) => {
                    // 在真正执行前，先按 isConcurrencySafe 来获取锁
                    if (isSafe) {
                        await registry.acquireConcurrent();
                        console.log(`[并发]${name}获取共享锁`);
                    } else {
                        await registry.acquireExclusive();
                        console.log(`[独占]${name}获取独占锁,等待其他工具完成`);
                    }
                    try {
                        const raw = await executeFn(input);
                        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                        return truncateResult(text, maxChars);
                    } finally {
                        // 无论是否出错，都释放锁
                        if (isSafe) {
                            registry.releaseConcurrent(); // 释放共享锁
                        } else {
                            registry.releaseExclusive(); // 释放独占锁
                        }
                    }
                },
            };
        }
        return result;
    }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS) {
    if (text.length <= maxChars) return text

    const headSize = Math.floor(maxChars * 0.6) //头部
    const tailSize = maxChars - headSize //尾部
    const head = text.slice(0, headSize)
    const tail = text.slice(-tailSize)
    const dropped = text.length - headSize - tailSize //截断的字符数
    return `${head}\n\n...[省略${dropped}个字符] \n\n${tail}`;
}
