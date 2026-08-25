import { streamText, type ModelMessage } from "ai";

const MAX_STEPS = 10 // 最大循环次数

export async function agentLoop(model: any, tools: any, messages: ModelMessage[], system: string) {
  let step = 0

  while (step < MAX_STEPS) {
    step++
    console.log(`\n--- Step ${step} ---`);

    const result = streamText({
      model,
      tools,
      messages,
      system
      // 不配置 stopwhen，就只会跑一次
    })

    let hasToolCall = false
    let fullText = ''

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text);
          fullText += part.text;
          break;
        case 'tool-call':
          hasToolCall = true
          console.log(`\n  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);
          break;
        case 'tool-result':
          console.log(`  [结果: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    const stepMessages = await result.response
    messages.push(...stepMessages.messages)

    // 退出条件
    if (!hasToolCall) {
      if (fullText) console.log()
      break
    }

    // 还有工具调用，继续循环
    console.log(' --> 模型还在工作，继续下一步...');
    
  }

  if (step >= MAX_STEPS) {
    console.log('循环次数超过最大限制，退出循环。')
  }

}