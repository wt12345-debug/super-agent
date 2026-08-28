import 'dotenv/config'
import { streamText, type ModelMessage, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
// import { weatherTool } from './tools/utility-tools'
import { allTools } from './tools/tools'
import { ToolRegistry } from './tools/tool-register'
import { agentLoop, type BudgetState } from './agent/loop'
// const tools = {
//     get_weather: weatherTool,
// }
const registry = new ToolRegistry()
registry.register(...allTools)
console.log(`已注册:${registry.getAll().length}个工具`);
for (const tool of registry.getAll()) {
    const flags = [
        tool.isConcurrencySafe ? '可并发' : '串行',
        tool.isReadOnly ? '只读' : '读写',
    ].join(', ')
    console.log(` -- ${tool.name}:${flags}`);

}

const messages: ModelMessage[] = []
const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有以下工具可用：read_file, write_file, list_directory。
需要查询信息或操作文件时，主动使用工具，不要编造数据。
可以同时调用多个互不冲突的工具来提高效率。
回答要简洁直接。`;
const qwen = createOpenAI({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.DASHSCOPE_API_KEY,

})


const rl = createInterface({  // 创建readline接口，用于从命令行读取用户输入
    input: process.stdin,
    output: process.stdout,
})

const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen-plus-latest') : createMockModel()

// function ask() {
//     rl.question('\nYou:', async (input) => {
//         const trimmed = input.trim();
//         if (!trimmed || trimmed === 'exit') {
//             console.log('Bye!');
//             rl.close();
//             return
//         }
//         messages.push({
//             role: 'user',
//             content: trimmed,
//         })
//         const result = streamText({
//             model: model as any,
//             system: `你是 Super Agent，一个有工具调用能力的助手。需要时主动使用工具获取信息，不要编造数据`,
//             tools,
//             messages,
//             stopWhen: stepCountIs(5),
//         })
//         process.stdout.write('Assistant:')
//         let response = ''
//         for await (const part of result.fullStream) {
//             switch (part.type) {
//                 case 'text-delta':
//                     process.stdout.write(part.text)
//                     response += part.text
//                     break;
//                 case 'tool-call':
//                     console.log(`\n工具调用: ${part.toolName}(${JSON.stringify(part.input)})`)
//                     break;
//                 case 'tool-result':
//                     console.log(`\n [工具返回] ${JSON.stringify(part.output)}`);
//                     break;
//             }

//         }
//         console.log(); //换行

//         messages.push({
//             role: 'assistant',
//             content: response,
//         })
//         ask()
//     })
// }


// async function main() {
//     const result = streamText({
//         model:model as any,
//         prompt: '用一句话介绍你自己',
//     })
//     for await (const chunk of result.textStream) {
//         process.stdout.write(chunk)
//     }
// }

// main()

const budget: BudgetState = { used: 0, limit: 15000 } //token 预算
function ask() {
    rl.question('\nYou: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return;
        }

        messages.push({ role: 'user', content: trimmed });

        await agentLoop(model, registry, messages, SYSTEM, budget)

        ask()
    })
}
console.log('这是owner-Agent v0.3 - Agent-Loop (type "exit" to quit)');
console.log('试试输入：“测试死循环”');

ask()