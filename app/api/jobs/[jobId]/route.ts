import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.getJob(request, jobId))
}
