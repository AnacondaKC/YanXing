const csrfCookieName = process.env.NODE_ENV === 'production' ? '__Host-yanxing_csrf' : 'yanxing_csrf'

export function mutationHeaders(headers: Record<string, string> = {}) {
  let token = ''
  try {
    const matches = document.cookie.split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith(csrfCookieName + '='))
    if (matches.length !== 1) return { ...headers, 'X-YanXing-CSRF': '' }
    const separator = matches[0].indexOf('=')
    token = decodeURIComponent(matches[0].slice(separator + 1))
  } catch {
    token = ''
  }
  return { ...headers, 'X-YanXing-CSRF': token }
}

export function shouldRedirectToLogin(status: number, pathname: string) {
  return status === 401 && pathname !== '/login'
}

let loginRedirectStarted = false

function redirectToLoginIfUnauthorized(status: number) {
  if (typeof window === 'undefined' || !shouldRedirectToLogin(status, window.location.pathname) || loginRedirectStarted) {
    return false
  }
  loginRedirectStarted = true
  window.location.assign('/login')
  return true
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init)
  redirectToLoginIfUnauthorized(response.status)
  return response
}

export async function fetchPage<T>(
  input: string | URL,
  collectionKey: string,
  init: RequestInit = {},
  pageSize = 100,
  offset = 0,
): Promise<{ items: T[]; total: number; hasMore: boolean }> {
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)))
  const safeOffset = Math.max(0, Math.floor(offset))
  const url = new URL(String(input), window.location.origin)
  url.searchParams.set('limit', String(safePageSize))
  url.searchParams.set('offset', String(safeOffset))
  const response = await apiFetch(url, init)
  if (!response.ok) throw new Error('列表请求失败（HTTP ' + response.status + '）。')
  const body = await response.json() as Record<string, unknown> | null
  const items = body && Array.isArray(body[collectionKey]) ? body[collectionKey] as T[] : undefined
  if (!items) throw new Error('列表响应格式无效。')
  const total = typeof body?.total === 'number' && Number.isSafeInteger(body.total) ? body.total : safeOffset + items.length
  return { items, total, hasMore: body?.hasMore === true && safeOffset + items.length < total }
}

export async function fetchAllPages<T>(
  input: string | URL,
  collectionKey: string,
  init: RequestInit = {},
  pageSize = 100,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = []
  let offset = 0
  let total = 0
  for (let page = 0; page < 100; page += 1) {
    const result = await fetchPage<T>(input, collectionKey, init, pageSize, offset)
    items.push(...result.items)
    total = result.total
    if (!result.hasMore || result.items.length === 0 || items.length >= total) return { items, total }
    offset += result.items.length
  }
  throw new Error('列表分页超过安全上限。')
}

