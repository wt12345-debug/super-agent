export type HookAction = 'allow' | 'block' | 'modify'

export interface HookResult {
    action: HookAction;
    reason?: string;
    modifiedInput?: any;
    modifiedOutput?: any;
}

export type PreToolHook = (toolName: string, input: any) => HookResult | Promise<HookResult>;

export type PostToolHook = (toolName: string, input: any, output: any) => HookResult | Promise<HookResult>;

/**
 * 工具调用钩子管线。
 *
 * Pre 钩子在工具执行前运行，可以放行（allow）、拦截（block）或改写入参（modify）；
 * Post 钩子在工具执行后运行，此时只能改写输出，block 已无意义、会被忽略。
 *
 * 钩子按注册顺序串行执行；单个钩子抛错只会被记录并跳过（fail-open），
 * 不会中断整条链路，也不会让工具调用被意外拦截。
 */
export class HookPipeline {
    private preHooks: Array<{ name: string, fn: PreToolHook }> = [];
    private postHooks: Array<{ name: string, fn: PostToolHook }> = [];

    /** 注册 Pre 钩子，name 仅用于日志与 /hooks 列表展示 */
    registerPre(name: string, fn: PreToolHook): void {
        this.preHooks.push({ name, fn });
    }
    /** 注册 Post 钩子，name 仅用于日志与 /hooks 列表展示 */
    registerPost(name: string, fn: PostToolHook): void {
        this.postHooks.push({ name, fn });
    }

    /**
     * 依次执行 Pre 钩子。
     * 任一钩子返回 block 会立即短路并返回该结果；返回 modify 时其 modifiedInput
     * 会作为后续钩子以及工具实际执行时使用的入参。
     */
    async runPre(toolName: string, input: any): Promise<HookResult> {
        let currentInput = input;

        for (const hook of this.preHooks) {
            try {
                const result = await hook.fn(toolName, currentInput);
                if (result.action === 'block') {
                    // 拦截：不再执行后续钩子，由调用方决定如何反馈给模型
                    console.log(` [hook: ${hook.name}] 拦截 ${toolName}: ${result.reason}`);
                    return result;
                }
                if (result.action === 'modify' && result.modifiedInput !== undefined) {
                    currentInput = result.modifiedInput;
                    console.log(` [hook: ${hook.name}] 修改了 ${toolName} 的输入`);
                }
            } catch (err) {
                // 钩子异常按 fail-open 处理：记录日志后继续执行剩余钩子
                const msg = err instanceof Error ? err.message : String(err);
                console.error(` [hook: ${hook.name}] 执行Pre异常: ${msg}`);
            }
        }
        return { action: 'allow' };
    }

    /**
     * 依次执行 Post 钩子，钩子之间可链式改写输出。
     * 仅当确有钩子改写输出时才返回 modifiedOutput，避免调用方在无需改写时重复处理输出。
     */
    async runPost(toolName: string, input: any, output: any): Promise<HookResult> {
        let currentOutput = output;
        let modified = false;

        for (const hook of this.postHooks) {
            try {
                const result = await hook.fn(toolName, input, currentOutput);
                if (result.action === 'modify' && result.modifiedOutput !== undefined) {
                    currentOutput = result.modifiedOutput;
                    modified = true;
                }
            } catch (err) {
                // 钩子异常按 fail-open 处理：记录日志后继续执行剩余钩子
                const msg = err instanceof Error ? err.message : String(err);
                console.error(` [hook: ${hook.name}] 执行Post异常: ${msg}`);
            }
        }

        return modified ? { action: 'allow', modifiedOutput: currentOutput } : { action: 'allow' };
    }

    /** 列出已注册钩子的名称，供 /hooks 命令展示 */
    list(): { pre: string[], post: string[] } {
        return {
            pre: this.preHooks.map(hook => hook.name),
            post: this.postHooks.map(hook => hook.name),
        };
    }
}