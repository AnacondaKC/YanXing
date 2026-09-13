import assert from 'node:assert/strict'
import test from 'node:test'
import { AiQueueFullError, aiQueueHttpFailure } from '../lib/ai/queue-policy'

test('queue capacity failures remain retryable HTTP 429 without a usage budget', () => {
  const error = new AiQueueFullError()
  assert.deepEqual(aiQueueHttpFailure(error), {
    body: { error: 'AI 任务队列已满，请稍后重试。', code: 'AI_QUEUE_FULL' },
    status: 429,
    headers: { 'Retry-After': '30' },
  })
})
