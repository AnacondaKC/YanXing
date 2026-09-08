export interface PaginationInput {
  limit: number
  offset: number
}

interface PaginationDefaults {
  limit?: number
  maxLimit?: number
}

const DEFAULT_MAX_LIMIT = 100
const DEFAULT_OFFSET = 0
export const MAX_OFFSET = 100_000

export class PaginationRangeError extends Error {
  constructor(message = '分页偏移超出允许范围。') {
    super(message)
    this.name = 'PaginationRangeError'
  }
}

export function parsePagination(request: Request, defaults: PaginationDefaults = {}): PaginationInput {
  const url = new URL(request.url)
  const maxLimit = positiveInteger(defaults.maxLimit, DEFAULT_MAX_LIMIT)
  const defaultLimit = Math.min(positiveInteger(defaults.limit, maxLimit), maxLimit)
  const limit = boundedInteger(url.searchParams.get('limit'), defaultLimit, 1, maxLimit)
  const offset = parseOffset(url.searchParams.get('offset'))
  return { limit, offset }
}

export function paginationRangeFailure(error: unknown): { error: string; status: 400 } | undefined {
  if (error instanceof PaginationRangeError) return { error: error.message, status: 400 }
}

export function pageResult<T>(items: T[], total: number, pagination: PaginationInput) {
  const nextOffset = pagination.offset + items.length
  return {
    items,
    total,
    limit: pagination.limit,
    offset: pagination.offset,
    hasMore: items.length > 0 && nextOffset < total && nextOffset <= MAX_OFFSET,
  }
}

function parseOffset(value: string | null) {
  if (!value) return DEFAULT_OFFSET
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < DEFAULT_OFFSET) return DEFAULT_OFFSET
  if (parsed > MAX_OFFSET) throw new PaginationRangeError()
  return parsed
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
