import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ projectId: string; stageId: string }> }) {
  const { projectId, stageId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.listStageReports(request, projectId, stageId))
}
