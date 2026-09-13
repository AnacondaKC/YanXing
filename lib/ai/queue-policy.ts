export class AiQueueFullError extends Error {
  constructor() {
    super('AI 任务队列已满，请稍后重试。')
    this.name = 'AiQueueFullError'
  }
}

export function aiQueueHttpFailure(error: AiQueueFullError) {
  return {
    body: { error: error.message, code: 'AI_QUEUE_FULL' },
    status: 429,
    headers: { 'Retry-After': '30' },
  }
}
