import type { RateLimitDecision } from '@/lib/security/rate-limit'

export function rateLimitFailure(
  decision: RateLimitDecision,
  rejected: { error: string; retryAfterSeconds?: number },
): { body: { error: string; retryAfterSeconds?: number }; status: number; headers: { 'Retry-After': string } } | undefined {
  if (decision.unavailable) {
    return {
      body: { error: '限流服务暂时不可用，请稍后再试。' },
      status: 503,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    }
  }
  if (!decision.allowed) {
    return {
      body: rejected,
      status: 429,
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
    }
  }
  return undefined
}
