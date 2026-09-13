import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ projectId: string }> }

export async function GET(request: Request, context: Context) {
  const { projectId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.listProjectReports(request, projectId))
}

export async function POST(request: Request, context: Context) {
  const { projectId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.confirmReport(request, projectId))
}
