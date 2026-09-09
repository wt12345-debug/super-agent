import { ToolRegistry } from "../tools/register";
import { SubAgentRegistry } from "./registry";
import { SpawnRequest } from "./types";
export interface SpawnContext {
    model: any;
    registry: ToolRegistry;
    agentRegistry: SubAgentRegistry;
    buildSystem: () => string;
    currentDepth: number;
}

const EXCLUDED_TOOLS = new Set(['spawn_agent']) // 不允许子Agent调用spawn_agent工具

const AGENT_COLORS = [
    '\x1b[36m',  // cyan
    '\x1b[33m',  // yellow
    '\x1b[35m',  // magenta
    '\x1b[32m',  // green
    '\x1b[34m',  // blue
];
const RESET = '\x1b[0m';
function agentTag(index: number, runId: string): string {
    const color = AGENT_COLORS[index % AGENT_COLORS.length]
    return `${color}[Agent-${index + 1}: ${runId}]${RESET}`
}
export async function spawnAgent(
    request: SpawnRequest,
    ctx: SpawnContext,
    index = 0
): Promise<string> {
    const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth)
    if (!ok) return `[spawn] 拒绝: ${reason}`

    const runId = ctx.agentRegistry.generateId()
    const tag = agentTag(index, runId)
}