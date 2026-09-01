import type { ToolDefinition } from './register'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'



export const readFileTool: ToolDefinition = {
    name: 'read_File',
    description: '读取指定路径的文件内容',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径',
            }
        },
        required: ['path'],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 500,
    execute: async ({ path }: { path: string }) => {
        return readFileSync(resolve(path), 'utf-8')
    },
}


export const writeFileTool: ToolDefinition = {
    name: 'write_File',
    description: '写入内容到指定文件',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径',
            },
            content: {
                type: 'string',
                description: '要写入的文件内容',
            }
        },
        required: ['path', 'content'],
        additionalProperties: false,
    },
    isConcurrencySafe: false, //写入操作不能并发
    isReadOnly: false,
    execute: async ({ path, content }: { path: string, content: string }) => {
        writeFileSync(resolve(path), content)
        return `已写入 ${content.length} 个字符到 ${path}`
    },
}

export const listDirectoryTool: ToolDefinition = {
    name: 'list_directory',
    description: '列出指定目录下的文件和子目录',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: '目录路径，默认为当前目录' },
        },
        required: [],
        additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ path = '.' }: { path?: string }) => {
        const resolved = resolve(path);
        const entries = readdirSync(resolved);
        return entries.map(name => {
            try {
                const stat = statSync(join(resolved, name));
                return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`;
            } catch {
                return `[?] ${name}`;
            }
        }).join('\n');
    },
};
// 编辑文件
export const editFileTool: ToolDefinition = {
    name: 'edit_file',
    description: '精确替换文件中的制定内容，用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写，只改你指定的部分',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '文件路径',
            },
            old_string: {
                type: 'string',
                description: '要被替换的原始文本（必须精确匹配）',
            },
            new_string: {
                type: 'string',
                description: '替换后的新文本',
            }
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false
    },
    isConcurrencySafe: false,  // 编辑操作不能并发
    isReadOnly: false,
    execute: async ({ path, old_string, new_string }: { path: string, old_string: string, new_string: string }) => {
        const resolved = resolve(path);
        if (!existsSync(resolved)) return `文件不存在: ${path}`

        const content = readFileSync(resolved, 'utf-8')
        const count = content.split(old_string).length - 1

        if (count === 0) {
            return `未找到匹配的内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
        }

        if (count > 1) {
            return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
        }

        const updated = content.replace(old_string, new_string);
        writeFileSync(resolved, updated, 'utf-8')
        return `已替换 ${path} 中的内容（${old_string} ➡ ${new_string} 字符）`

    }
}