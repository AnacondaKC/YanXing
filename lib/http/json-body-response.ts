import { NextResponse } from 'next/server'

export function jsonBodyFailureResponse(status: 408 | 413) {
  return NextResponse.json(
    { error: status === 408 ? '请求体读取超时。' : '请求体超过大小限制。' },
    { status },
  )
}
