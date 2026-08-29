# 项目起手
1. pnpm init 初始化项目
2. pnpm install typescript --save-dev 安装typescript
3. tsc --init 初始化typescriptconfig.json

4. pnpm add ai @ai-sdk/openai dotenv (ai 这个SDK 主要是以openai的标准用来调用openai的api)
5. pnpm add -D tsx @types/node

# ai这个SDK
- generateText 生成文本
- streamText 流式生成文本

# 进程持续
- readline 读取用户输入
- process.stdout.write 写入标准输出
- process.stdin.write 写入到标准输入
- process.exit 退出进程

# 模型调用三要素
1. 模型调用：StreamConsumer  --- 解析工具调用，推理过程，token用量等多种事件
2. 消息管理： 四层上下文管理 -- 截断，时间衰减修剪，LLM摘要压缩，Cache优化
3. 交互循环：AgentLoop ---while(true){think -> act -> observe}  <!-- ask递归调用-->

# 从能聊天到能干活
user: 南昌今天天气怎么样？
agent:[调用get_weather工具] 今天南昌天气晴朗，温度在25摄氏度左右。

- SDK ai 提供的 streamText 方法存在自动循环机制
 用户提问 -> 模型说要调用工具 -> 调用工具 -> 得到工具返回结果 -> 再次调用模型，将工具返回结果作为模型的输入 -> 模型返回结果给用户

 - 可定制性太差 --- 我们没办法在循环的步骤中间插入自定义的逻辑（比如：添加日志，添加缓存，添加错误处理等）

# 上保险丝
1. 死循环检测：连续调用相同的工具 + 相同的参数？  打断循环
   1. 通用循环：同一个工具，相同参数，相同结果，重复调用。
      - 将工具名 + 参数做一个确定性的JSON 序列化，再哈希加密，
      get_weather({city:'南昌'}) ->12x12312414cadqs
      - 滑动窗口: 比如就看最近的 30 轮有没有重复的文件指纹。
      - 同样的输入 + 同样的输出 == 无进展  （只有调用指纹和结果指纹都相同，才认为是无进展的）

   2. 乒乓循环：两个工具，交替调用，结果没有进展。
   3. 轮询无进展：不断地poll检查状态，但是状态没有变化。


2. Token 预算：烧了多少token？ 超过预算？ 打断循环
  - 把每一步的token用量都记录下来，超过预算后，就打断循环
3. API容错：请求重试，降低模型
   - 错误要分类，有些错误值得重试，有些错误不值得重试
 - 从能跑 到 ‘跑不挂’


# 工具系统
搭建一个正经的系统，从工具的注册到执行到截断，每一层都要有明确的职责

- 对于模型来说，Tool是什么样的存在？
  1. 一段描述 --- 告诉模型这个工具是做什么的，什么时候该用
  2. 一份参数 Schema -- 告诉模型这个工具需要哪些参数，参数的类型，参数的必填性等
  3. 一个执行函数 --- 真正的逻辑


  * 在生产环境中，还要注意这个工具能否和别的工具并发执行

  ## 并发控制
  1. 模型在一次回复中说要调用多个工具，AI SDK会并发的执行所有带有 execute 属性的工具
  - 需要 读写锁 来保护工具的执行，防止多个工具同时执行导致的并发问题

  - 经典思路：
  1. 只读工具：获取共享锁，可以和其他只读工具同时持有
  2. 读写工具：获取独占锁，必须等所有其他工具执行完毕后，才能执行

  * 假设同时有三个工具要触发，read_file, write_file, write_file。AI SDK 会同时执行三个 execute 方法。但是在执行逻辑之前，先判断该工具是否安全。如果安全，就执行并记录当前有一个工具正在执行。如果不安全，就在队列中塞入阻塞函数，阻止当前的工具执行，直到其他工具执行完毕。才放开阻塞函数进而带来了当前工具的执行。
  - ToolRegistry 解耦了工具定义和使用
  - 结果截断
  - 读写锁的并发控制

  ## 联网搜索
    1. Tavily 搜索引擎  (免费1000次/月)  -- AI原生
    2. Serper 搜索引擎  (免费2500次/月)  -- Goole 搜索引擎代理

    - 双引擎实现
      1. 
# Agent 接入MCP

  1. 接入 GitHub MCP服务器
 - MCP 的通信协议 是 JSON RPC 2.0,,传输方式支持 stdio 和 Streamable HTTP.我们只启用 stdio 本地进程，通过标准的输入输出来收发消息

 - 我们的Agent（client）启动一个对接 MCP Server进程，通过stdio 发JSON消息给github mcp server。github mcp server 会向我们的进程中返回JSON消息，我们通过stdout 读取这些消息。

 1. 握手  --- Client 发initialize method 给Server，Server 返回一个 JSON-RPC 2.0 的response，回复他支持的能力。
 2. 发现工具 --- client 发 tools/list method 给Server，Server 返回所有的工具名称、描述、参数schema等信息。
 3. 调用工具  --- 模型决定调用某个MCP 工具，client 发 tools/call method 给Server，Server会执行该工具， 返回工具的执行结果。