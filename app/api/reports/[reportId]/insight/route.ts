import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ reportId: string }> }

export async function GET(request: Request, context: Context) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.getInsight(request, reportId))
}

export async function POST(request: Request, context: Context) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.startInsight(request, reportId))
}
