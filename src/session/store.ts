import { ModelMessage } from 'ai'
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export interface SessionEntry {
    type: 'message',
    timestamp: string,
    message: ModelMessage,
}
const SESSION_DIR = '.sessions'
const DEFAULT_SESSION = 'default'

export class SessionStore {
    private dir: string = ''
    private sessionId: string = ''
    constructor(sessionId: string = DEFAULT_SESSION) {
        this.sessionId = sessionId
        this.dir = SESSION_DIR
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true })
        }
    }
    private get filePath() {
        return join(this.dir, `${this.sessionId}.jsonl`)  // ./sessions/default.jsonl
    }
    // 追加消息到会话文件
    append(message: ModelMessage) {
        const entry: SessionEntry = {
            type: 'message',
            timestamp: new Date().toISOString(),
            message,
        }
        appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8')
    }
    appendAll(messages: ModelMessage[]) {
        for (const message of messages) {
            this.append(message)
        }
    }
    // 从会话文件加载消息
    load(): ModelMessage[] {
        if (!existsSync(this.filePath)) return []
        const content = readFileSync(this.filePath, 'utf-8').trim()
        if (!content) return []

        const messages: ModelMessage[] = []
        for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
                const entry: SessionEntry = JSON.parse(line)
                if (entry.type === 'message') {
                    messages.push(entry.message)
                }
            } catch {
                // skip malformed lines
            }
        }
        return messages
    }
    // 检查会话文件是否存在
    exists(): boolean {
        return existsSync(this.filePath)
    }
}
