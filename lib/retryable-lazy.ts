export type RetryableLazyStatus = 'idle' | 'pending' | 'loaded' | 'failed'

export type RetryableLazySnapshot<T> = {
  status: RetryableLazyStatus
  value: T | undefined
  error: unknown
  attemptCount: number
}

export type RetryableLazyResource<T> = {
  load(): Promise<T>
  snapshot(): RetryableLazySnapshot<T>
}

export function createRetryableLazyResource<T>(importModule: () => Promise<T>): RetryableLazyResource<T> {
  let status: RetryableLazyStatus = 'idle'
  let value: T | undefined
  let error: unknown
  let attemptCount = 0
  let inFlight: Promise<T> | undefined

  function snapshot(): RetryableLazySnapshot<T> {
    return { status, value, error, attemptCount }
  }

  function load(): Promise<T> {
    if (status === 'loaded') return Promise.resolve(value as T)
    if (inFlight) return inFlight
    return startAttempt()
  }

  function startAttempt(): Promise<T> {
    attemptCount += 1
    status = 'pending'
    error = undefined
    let modulePromise: Promise<T>
    try {
      modulePromise = Promise.resolve(importModule())
    } catch (syncError) {
      modulePromise = Promise.reject(syncError)
    }
    const attempt = modulePromise.then((nextValue) => {
      status = 'loaded'
      value = nextValue
      inFlight = undefined
      return nextValue
    }, (nextError: unknown) => {
      status = 'failed'
      error = nextError
      inFlight = undefined
      throw nextError
    })
    inFlight = attempt
    void attempt.then(ignoreSettlement, ignoreSettlement)
    return attempt
  }

  return { load, snapshot }
}

function ignoreSettlement() {}
