import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.startAnalysis(request, reportId))
}
