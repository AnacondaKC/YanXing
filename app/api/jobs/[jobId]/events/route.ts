import { NextResponse } from 'next/server'
import { getJob, getJobEvents, type JobEvent } from '@/lib/db/repository'
import { getRequestUser } from '@/lib/auth/request'
import { terminalAnalysisJobStatuses } from '@/lib/analysis-job-progress'

export const runtime = 'nodejs'
const basePollIntervalMs = 700
const maxPollIntervalMs = 5_000
const pollIdleGrowthFactor = 1.5
const maxConnectionsPerUser = 20
const eventBatchSize = 100
const maxStreamDurationMs = 30 * 60 * 1000

const connectionCounts = new Map<string, number>()

function tryAcquireConnection(userId: string) {
  const current = connectionCounts.get(userId) ?? 0
  if (current >= maxConnectionsPerUser) return false
  connectionCounts.set(userId, current + 1)
  return true
}

function releaseConnection(userId: string) {
  const remaining = (connectionCounts.get(userId) ?? 1) - 1
  if (remaining <= 0) connectionCounts.delete(userId)
  else connectionCounts.set(userId, remaining)
}

function parseEventCursor(request: Request) {
  const header = request.headers.get('last-event-id')
  const headerId = Number(header ?? '')
  if (header !== null && header !== '' && Number.isSafeInteger(headerId) && headerId >= 0) return headerId
  const after = new URL(request.url).searchParams.get('after')
  const queryId = Number(after ?? '')
  if (after !== null && after !== '' && Number.isSafeInteger(queryId) && queryId >= 0) return queryId
  return 0
}

function encodeJobEventBatch(events: JobEvent[]) {
  return events.map((event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params
  const user = getRequestUser(request)
  if (!user) return new Response('unauthorized', { status: 401 })
  if (!getJob(jobId)) return new Response('job not found', { status: 404 })

  if (!tryAcquireConnection(user.id)) {
    return new Response('too many concurrent event streams', { status: 429 })
  }

  let lastEventId = parseEventCursor(request)
  const streamDeadline = Date.now() + maxStreamDurationMs
  let closed = false
  let released = false
  let idleIntervalMs = basePollIntervalMs
  let pending: JobEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closeStream: (() => void) | undefined
  const encoder = new TextEncoder()

  const release = () => {
    if (released) return
    released = true
    releaseConnection(user.id)
  }

  const waitForIdle = (intervalMs: number) => new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timer = undefined
      resolve()
    }, intervalMs)
  })

  const takeBatch = () => {
    if (pending.length === 0) pending = getJobEvents(jobId, lastEventId, eventBatchSize)
    if (pending.length === 0) return undefined
    idleIntervalMs = basePollIntervalMs
    const batch = pending
    pending = []
    lastEventId = batch[batch.length - 1]!.id
    return batch
  }

  try {
    const stream = new ReadableStream({
      start(controller) {
        const close = () => {
          if (closed) return
          closed = true
          if (timer) clearTimeout(timer)
          request.signal.removeEventListener('abort', close)
          release()
          try { controller.close() } catch { /* client disconnected */ }
        }
        closeStream = close
        request.signal.addEventListener('abort', close)
        if (request.signal.aborted) close()
      },
      async pull(controller) {
        if (closed) return
        if (Date.now() >= streamDeadline) {
          closeStream?.()
          return
        }
        try {
          const ready = takeBatch()
          if (ready) {
            controller.enqueue(encoder.encode(encodeJobEventBatch(ready)))
            return
          }
          const currentJob = getJob(jobId)
          if (!currentJob || terminalAnalysisJobStatuses.has(currentJob.status)) {
            closeStream?.()
            return
          }
          await waitForIdle(idleIntervalMs)
          if (closed) return
          idleIntervalMs = Math.min(maxPollIntervalMs, Math.max(basePollIntervalMs, Math.round(idleIntervalMs * pollIdleGrowthFactor)))
          const late = takeBatch()
          if (late) {
            controller.enqueue(encoder.encode(encodeJobEventBatch(late)))
            return
          }
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          closeStream?.()
        }
      },
      cancel() {
        closeStream?.()
      },
    })

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'private, no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    release()
    throw error
  }
}
