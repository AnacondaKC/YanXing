import { NextResponse } from 'next/server'

export type SettingsRevisionScope = 'models' | 'prompts' | 'budget' | 'branding'

export interface SettingsRevisionCondition {
  revision: number
}

export function requireSettingsRevision(
  value: unknown,
  request: Request,
  scope: SettingsRevisionScope,
): SettingsRevisionCondition | NextResponse {
  const header = request.headers.get('if-match')
  const headerMatch = header === null ? undefined : header.match(new RegExp('^\"' + scope + '-(\\d+)\"$'))
  if (header !== null && !headerMatch) return NextResponse.json({ error: 'If-Match 版本无效，请刷新后重试。' }, { status: 400 })
  const headerRevision = headerMatch ? Number(headerMatch[1]) : undefined
  if (headerRevision !== undefined && (!Number.isSafeInteger(headerRevision) || headerRevision < 1)) return NextResponse.json({ error: 'If-Match 版本无效，请刷新后重试。' }, { status: 400 })
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)) return NextResponse.json({ error: '设置版本无效，请刷新后重试。' }, { status: 400 })
  const bodyRevision = value === undefined ? undefined : Number(value)
  if (bodyRevision !== undefined && headerRevision !== undefined && bodyRevision !== headerRevision) return NextResponse.json({ error: '请求中的设置版本不一致。' }, { status: 400 })
  const revision = bodyRevision ?? headerRevision
  if (revision === undefined) return NextResponse.json({ error: '设置版本已缺失，请刷新后重试。' }, { status: 428 })
  return { revision }
}
