import type { ToolDefinition } from './register'
import { readFileTool, writeFileTool, editFileTool, listDirectoryTool } from './file-tools'
import { bashTool } from './shell-tools'
import { globTool, grepTool } from './search-tools'
import { pickSearchTool, webFetchTool } from './web-search'

export const allTools: ToolDefinition[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    bashTool,
    webFetchTool,
    pickSearchTool(),
]
//核心工具
export {
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    globTool,
    grepTool,
    bashTool,
}

