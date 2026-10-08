import type { PluginDefinition, PluginConfig, PluginApi } from './types';
import type { ToolRegistry, ToolDefinition } from '../tools/register';

/** 已加载插件的运行时记录：保留插件定义，以及它贡献给注册表的工具名 */
interface LoadedPlugin {
  definition: PluginDefinition;
  tools: string[];
}

/**
 * 插件管理器：负责插件工具的动态注册与注销。
 *
 * 插件自带的工具统一加上 `<插件名>__` 前缀后再注册进 ToolRegistry，
 * 避免不同插件之间、插件与内置工具之间发生命名冲突；
 * 卸载时按这份前缀名单反向清理，保证注册表回到加载前的状态。
 */
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** 插件工具在全局注册表中的命名空间前缀，例如 `supabase__` */
  private static toolPrefix(pluginName: string): string {
    return `${pluginName}__`;
  }

  /** 判断插件是否已加载 */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * 加载并激活一个插件。
   * 配置优先级：Agent 传入的 config 覆盖插件自带的 config。
   * @returns 本次注册进 ToolRegistry 的工具名列表
   */
  async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
    if (this.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`);
    }

    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config, // Agent 配置覆盖插件默认配置
    });

    const prefix = PluginManager.toolPrefix(definition.name);
    const registeredTools: string[] = []; // 插件携带的工具名称

    const api: PluginApi = {
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${prefix}${tool.name}`;
          const prefixedTool: ToolDefinition = {
            ...tool,
            name: prefixedName,
            description: `[Plugin: ${definition.name}] ${tool.description}`
          };
          this.registry.register(prefixedTool); // 将插件携带的工具注册到工具注册表中
          registeredTools.push(prefixedName);
        }
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        console.log(` [Plugin: ${definition.name}] ${message}`)
      }
    }

    try {
      await definition.activate(api); // 激活插件
    } catch (error) {
      // 激活失败：回滚已注册的工具，避免插件未被记录却留下残余工具
      for (const toolName of registeredTools) {
        this.registry.unregister(toolName);
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error(` [Plugin: ${definition.name}] 激活失败: ${msg}`)
      throw error;
    }

    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools
    });

    return registeredTools
  }

  /** 卸载插件：先触发 destroy 钩子释放资源，再从注册表移除它的全部工具 */
  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy();
      } catch (err) {
        // destroy 失败不应中断卸载，记录后继续清理工具
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [Plugin: ${name}] destroy 出错: ${msg}`);
      }
    }

    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName);
    }

    this.plugins.delete(name);
    return true;
  }

  /** 卸载全部插件（进程退出前调用，确保插件资源被释放） */
  async unloadAll(): Promise<void> {
    // 先复制键列表，避免遍历过程中 Map 被修改
    for (const name of Array.from(this.plugins.keys())) {
      await this.unload(name);
    }
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): Array<{ name: string; version: string; description: string; tools: string[] }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }));
  }

  /** 把配置值中的 `${ENV_NAME}` 占位符替换为对应环境变量（变量缺失时退化为空字符串） */
  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const envKey = value.slice(2, -1);
        resolved[key] = process.env[envKey] || '';
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

}