import { serveSubmissionReportFile } from '@/lib/http/submission-report-file'
import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ reportId: string }> }

export async function GET(request: Request, context: Context) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => serveSubmissionReportFile({ runtime, request, reportId, includeBody: true }))
}

export async function HEAD(request: Request, context: Context) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => serveSubmissionReportFile({ runtime, request, reportId, includeBody: false }))
}
