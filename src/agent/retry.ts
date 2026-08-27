// 判断是否值得重试
export function isRetryable(error: unknown) {
    if (!(error instanceof Error)) {
        return false
    }
    const message = error.message || ''
    //HTTP状态码判断
    const statusMatch = message.match(/(\d{3})/)
    if (statusMatch) {
        const status = parseInt(statusMatch[1])
        if ([429, 529, 408].includes(status)) return true
        if (status >= 500 && status < 600) return true  // 服务器错误LLM问题，重试
        if (status >= 400 && status < 500) return false // 客户端错误，不重试
    }
    //网络错误
    // 网络错误
    if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
    if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
    if (message.includes('fetch failed') || message.includes('network')) return true;
    // AI SDK 会把流式错误包装成 NoOutputGeneratedError
    if (message.includes('No output generated')) return true;

    return false;
}

// 指数退避 + 随机抖动
export function calculateDelay(attempt:number,baseMs = 500,maxMs = 30000):number{
    const exponential = baseMs * Math.pow(2, attempt - 1)
    const capped = Math.min(exponential, maxMs)
    const jitterRange = capped * 0.25
    const jittered = capped + (Math.random()*2 - 1) * jitterRange

    return Math.max(0,Math.round(jittered))
    
}

export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
