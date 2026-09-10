export interface SubAgentConfig{
    maxSpawnDepth: number; //最大嵌套深度 默认1
    maxConcurrent: number; //最大并行子Agent数 默认3
    defaultTimeout: number; //默认超时时间 默认6000ms
}
export const DEFAULT_CONFUG: SubAgentConfig = {
    maxSpawnDepth: 1,
    maxConcurrent: 3,
    defaultTimeout: 600000,
}

export interface SpawnRequest{
    task:string; // 子agent任务描述
    tools?:string[]; //子Agent允许使用的工具 （不指定则默认继承父Agent的工具）
    timeout?:number; //子Agent超时时间 默认6000ms
}

export interface SubAgentRun{
    id:string; //运行ID
    task:string; //任务描述
    status:'running'|'completed'|'error'|'timeout'; //运行状态
    depth:number; //当前嵌套深度 
    startedAt:string; //开始时间戳
    finishedAt?:string; //完成时间戳
    result?:string; //运行结果
    error?:string; //运行错误信息
}