export interface SubAgentConfig{
    maxASpawnDepth: number; //最大嵌套深度 默认1
    maxConcurrent: number; //最大并行子Agent数 默认3
    defaultTimeout: number; //默认超时时间 默认6000ms
}
export const DEFAULT_CONFUG: SubAgentConfig = {
    maxASpawnDepth: 1,
    maxConcurrent: 3,
    defaultTimeout: 6000,
}