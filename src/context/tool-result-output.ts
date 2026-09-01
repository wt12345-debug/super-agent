import type { ToolResultPart } from "ai";

// 工具调用的结果输出xxxxxx ==> [tool result cleared]

type ToolResultOutput = ToolResultPart['output']

export function textToolResultOutput(value: string): ToolResultOutput {
  return {
    type: 'text',
    value: value,
  }
}

export function toolResultOutputToText(output: ToolResultOutput) {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'content':
      return output.value
        .map(part => {
          if (part.type === 'text') return part.text
          const mediaType = 'mediaType' in part ? part.mediaType : undefined
          return `[media:${mediaType ?? part.type}]`
        })
        .join('\n')
  }
}