import { jsonSchema } from 'ai'
import type { MCPClient } from './mcp-client'
import { canUseTool, type Role } from '../security/roles'
import { classifyBashCommand } from '../security/bash-classifier'
import type { HookPipeline } from '../security/hook'



export interface ToolDefinition {
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (input: any) => Promise<any>

    isConcurrencySafe?: boolean, //能否并行
    isReadOnly?: boolean,  //是否只读
    maxResultChars?: number, //最大结果字符数
    shouldDefer?: boolean, //是否延迟加载
    searchHint?: string, //搜索提示
}
const DEFAULT_MAX_RESULT_CHARS = 3000 //工具执行允许的最大输出字符数


export class ToolRegistry {
    private tools = new Map<string, ToolDefinition>() //工具列表
    private mcpClients: MCPClient[] = []  // 存放正在连接的 MCP 服务器


    // 用三个状态变量来构成一把锁
    private exclusiveLock = false;  //当前是否有独占锁的持有者
    private concurrentCount = 0; //当前共享锁的持有者数量
    private waitQueue: Array<() => void> = [] // 等待队列，阻塞等待中的 resolve 函数

    // 已发现的延迟工具列表
    private discoveredTools = new Set<string>()
    private currentRole: Role = 'owner' // 当前角色，默认owner
    private hookPipeline?: HookPipeline
    register(...tools: ToolDefinition[]): void {// 将来在任何地方定义的工具，都直接通过register方法注册，被存入tools Map工具列表
        for (const tool of tools) {
            this.tools.set(tool.name, tool)
        }
    }

    // 切换权限角色
    setRole(role: Role): void {
        this.currentRole = role
    }

    getRole(): Role {
        return this.currentRole
    }

    // hook 管线
    setHookPipeline(pipeline: HookPipeline): void {
        this.hookPipeline = pipeline
    }
    unregister(name: string): void {// 注销工具
        this.discoveredTools.delete(name)
        this.tools.delete(name)

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
                shouldDefer: true,
                searchHint: `${serverName} ${tool.name} ${tool.description}`,
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
    private async acquireConcurrent(): Promise<void> {
        while (this.exclusiveLock) {
            await new Promise<void>(resolve => this.waitQueue.push(resolve))
        }
        this.concurrentCount++
    }
    //释放共享锁
    private releaseConcurrent(): void {
        this.concurrentCount--
        if (this.concurrentCount === 0) this.drainQueue(); // 释放共享锁后，检查是否有等待中的 resolve 函数

    }
    //获取独占锁
    private async acquireExclusive(): Promise<void> {
        while (this.exclusiveLock || this.concurrentCount > 0) { //当有独占锁或共享锁时，等待队列中添加 resolve 函数，阻塞等待
            await new Promise<void>(resolve => this.waitQueue.push(resolve))
        }
        this.exclusiveLock = true
    }
    //释放独占锁
    private releaseExclusive(): void {
        this.exclusiveLock = false
        this.drainQueue(); // 释放独占锁后，检查是否有等待中的 resolve 函数
    }
    //锁释放时，把等待队列中的 resolve 全部唤醒，让他们重新去抢锁
    private drainQueue(): void {
        const waiting = this.waitQueue.splice(0)
        for (const resolve of waiting) {
            resolve()
        }

    }

    toAISDKFormat(): Record<string, any> {
        const result: Record<string, any> = {};
        const activeTools = this.getActiveTools();  // 

        for (const tool of activeTools) {
            const maxChars = tool.maxResultChars;
            const executeFn = tool.execute;
            const isSafe = tool.isConcurrencySafe === true;
            const registry = this;
            const toolName = tool.name

            const hookPipeline = registry.hookPipeline

            result[tool.name] = {
                description: tool.description,
                inputSchema: jsonSchema(tool.parameters as any),
                execute: async (input: any) => {
                    // Bash 风险检测
                    if (toolName === 'bash' && input?.command) {
                        const risk = classifyBashCommand(input.command)
                        if (risk.level === 'dangerous') {
                            return `[拒绝执行] 检测到危险操作：${risk.reason}\n命令：${input.command}`
                        }
                        if (risk.level === 'moderate') {
                            console.log(`  [安全警告] 操作：${risk.reason}\n命令：${input.command}`)
                        }
                    }

                    // pre hook
                    if (hookPipeline) {
                        const preResult = await hookPipeline.runPre(toolName, input)
                        if (preResult.action === 'block') {
                            return `[Hook 拦截] ${preResult.reason || '操作被阻止'}`
                        }
                        if (preResult.action === 'modify' && preResult.modifiedInput !== undefined) {
                            input = preResult.modifiedInput
                        }
                    }

                    // 在真正执行前，先按 isConcurrencySafe 来获取锁
                    if (isSafe) {
                        await registry.acquireConcurrent();
                        console.log(` [并发] ${tool.name} 获取共享锁`);
                    } else {
                        await registry.acquireExclusive();
                        console.log(` [串行] ${tool.name} 获得独占锁，等待其他工具完成`);
                    }

                    try {
                        const raw = await executeFn(input);
                        const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                        let output = truncateResult(text, maxChars);
                        // Post Hook
                        if (hookPipeline) {
                            const postResult = await hookPipeline.runPost(toolName, input, output)
                            if (postResult.modifiedOutput !== undefined) {
                                output = String(postResult.modifiedOutput)
                            }
                        }
                        return output

                    } finally {
                        // 无论是否成功，都释放锁
                        if (isSafe) {
                            registry.releaseConcurrent();  // 释放共享锁
                        } else {
                            registry.releaseExclusive();  // 释放独占锁
                        }
                    }
                },
            };
        }
        return result;
    }
    //搜索工具
    searchTools(query: string): ToolDefinition[] {
        const q = query.trim() //'mcp__github__list__issues,mcp__github__create__issue'
        const results: ToolDefinition[] = []
        //去 Map对象中搜索哪个值(对象)拥有 searchHint 属性，且 searchHint 包含 q 中的字符串
        const names = q.includes(',') ? q.split(',').map(n => n.trim()).filter(Boolean) : [q]
        for (const name of names) {
            const tool = this.tools.get(name) //去 Map对象中搜索 name 对应的工具
            if (tool && tool.name !== 'tool_search') {
                results.push(tool)
                //记录被搜到的延迟工具
                this.discoveredTools.add(tool.name)
            }
        }
        return results
    }

    // 可以被添加进prompt中的工具
    getActiveTools(): ToolDefinition[] {
        return this.getAll().filter(tool => {
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
                return false;
            }
            if (!canUseTool(this.currentRole, tool.name)) {
                return false;
            }

            return true;
        });
    }
    // 生成延迟工具的名字列表
    getDeferredToolSummary(): string {
        const deferred = this.getAll().filter(tool => {
            return tool.shouldDefer && !this.discoveredTools.has(tool.name);
        });

        if (deferred.length === 0) return '';

        const lines = deferred.map(t => {
            const hint = t.searchHint ? ` — ${t.searchHint}` : '';
            return `  - ${t.name}${hint}`;  // “工具名 — 搜索提示 eg: - mcp__notion__search_pages -notion search pages documents”格式
        });

        return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
    }
    // 估算 token
    countTokenEstimate(): { active: number, deferred: number, total: number } {
        let active = 0;
        let deferred = 0;
        for (const tool of this.getAll()) {
            const SchemaSize = JSON.stringify({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }).length
            const tokens = Math.ceil(SchemaSize / 4)
            if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
                deferred += tokens
            } else {
                active += tokens
            }
        }
        return { active, deferred, total: active + deferred }
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
