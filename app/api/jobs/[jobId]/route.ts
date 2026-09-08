import { NextResponse } from 'next/server'
import { getJob, listModuleStates } from '@/lib/db/repository'
import { getRequestUser } from '@/lib/auth/request'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params
  const user = getRequestUser(_request)
  if (!user) return NextResponse.json({ error: '未登录。' }, { status: 401 })
  const job = getJob(jobId)
  if (!job) return NextResponse.json({ error: '任务不存在。' }, { status: 404 })
  return NextResponse.json({ job, moduleStates: listModuleStates(jobId) })
}
