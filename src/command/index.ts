import type { ModelMessage } from 'ai';
import type { ToolRegistry } from '../tools/register.js';
import type { PromptBuilder, PromptContext } from '../context/prompt-builder.js';
import type { UsageTracker } from '../usage/tracker.js';
import type { SessionStore } from '../session/store.js';
import type { MemoryStore } from '../memory/store.js';


export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  model: any;
  makePromptCtx: () => PromptContext;
  ask: () => void;
  memoryStore?: MemoryStore;
  [key: string]: any;
}

export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean | 'async';

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx);
      if (result) return result;
    }
    return false;
  };
}