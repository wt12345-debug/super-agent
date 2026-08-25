import 'dotenv/config'
import { streamText, type ModelMessage, stepCountIs } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createMockModel } from './mock-model'
import { createInterface } from 'readline'
import { weatherTool } from './tools/utility-tools'
import { agentLoop } from './agent/loop'
const tools = {
    get_weather: weatherTool,
}
const messages: ModelMessage[] = []
const system = `你是 Super Agent，一个有工具调用能力的助手。需要时主动使用工具获取信息，不要编造数据`
const qwen = createOpenAI({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.DASHSCOPE_API_KEY,

})
const model = process.env.DASHSCOPE_API_KEY ? qwen.chat('qwen3.7-plus') : createMockModel()

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
})

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

function ask() {
    rl.question('\nYou:', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === 'exit') {
            console.log('Bye!');
            rl.close();
            return
        }
        messages.push({
            role: 'user',
            content: trimmed,
        })
        agentLoop(model, tools, messages,system)
        ask()
    })
}
console.log('这是owner-Agent v0.2 - Agent-Loop (type "exit" to quit)');
ask()