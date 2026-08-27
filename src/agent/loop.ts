import { streamText, type ModelMessage } from "ai";
import { detect, resetHistory, recordCall, recordResult } from './loop-detection'
import { isRetryable, calculateDelay, sleep } from './retry'

const MAX_STEPS = 15 // 最大循环次数
const MAX_RETRIES = 3 // 最大重试次数

export interface BudgetState {
  used: number
  limit: number
}

export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState
) {
  let step = 0

  resetHistory()  // 重置工具执行的历史记录

  while (step < MAX_STEPS) {
    step++
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false  // 当前这轮是否有工具调用
    let fullText = ''  // 当前这轮的模型输出
    let shouldBreak = false  // 是否需要熔断
    let lastToolCall: { name: string, input: unknown } | null = null  // 最后一个工具调用记录
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>;
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

    // 步骤重试：应该包裹 streamText，和 result的处理
    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          tools,
          messages,
          system,
          maxRetries: 0,  // 不配置重试，就只会跑一次
          onError: () => { }
          // 不配置 stopwhen，就只会跑一次
        })

        for await (const part of result.fullStream) {  // fullStream 是ai库生成一个水桶，里面装的是模型的输出，并且当工具调用完毕后会自动的将结果添加到水桶中
          switch (part.type) {
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;
            case 'tool-call':
              hasToolCall = true
              lastToolCall = { name: part.toolName, input: part.input }
              console.log(`\n  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`);
              // 检测是否需要熔断或警告
              const detection = detect(part.toolName, part.input)
              if (detection.stuck) {  // 至少到了危险警告阶段
                console.log(` ${detection.message}`);
                if (detection.level === 'critical') {  // 直接熔断
                  shouldBreak = true
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}，请换一个思路解决问题，不要重复同样的操作。`,
                  })
                }
              }

              recordCall(part.toolName, part.input)  // 记录当前这次的工具调用
              break;

            case 'tool-result':
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              // 记录工具调用结果指纹
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output)
              }
              break;
          }
        }

        stepResponse = await result.response
        stepUsage = await result.usage
        break

      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error
        const delay = calculateDelay(attempt)
        console.log(` [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`);  // 计算重试延迟
        await sleep(delay)
        hasToolCall = false
        fullText = ''
        shouldBreak = false
        lastToolCall = null
      }
    }


    // 判断是否需要熔断
    if (shouldBreak) {
      console.log('\n [循环检测触发，Agent已停止]')
      break
    }

    messages.push(...stepResponse!.messages)

    // Token 预算追踪：记录当前这轮的token用量 (输入+输出 的token计算已经在 streamText 中做了)
    const inp = typeof stepUsage?.inputTokens === 'number' ? stepUsage.inputTokens : ((stepUsage?.inputTokens as any)?.total ?? 0)
    const out = typeof stepUsage?.outputTokens === 'number' ? stepUsage.outputTokens : ((stepUsage?.outputTokens as any)?.total ?? 0)
    budget.used += inp + out
    const pct = Math.round((budget.used / budget.limit) * 100)
    console.log(` [Token 预算] 已使用 ${budget.used} / ${budget.limit}，(${pct}%)`)

    // 检查是否超过预算
    if (budget.used > budget.limit) {
      console.log('\n [Token 预算耗尽，强制停止]')
      break
    }


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