import type { ToolRegistry, ToolDefinition } from './register'

export function createToolSearchTool(registry: ToolRegistry): ToolDefinition {
    return {
        name: 'tool_search',
        description: '获取延迟工具的完整定义，传入工具名（从系统提示的延迟工具列表中获取），返回该工具的完整参数 Schema',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名' } }, required: ['query'] },
        isConcurrencySafe: true,
        isReadOnly: true,
        execute: async ({ query }: { query: string }) => {
            const results = registry.searchTools(query)  // 搜出来哪些工具的searchHint 包含 query 字符串
            return results.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            }))
        }
    }
}