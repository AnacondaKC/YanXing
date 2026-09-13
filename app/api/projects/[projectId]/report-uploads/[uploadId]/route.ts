import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ projectId: string; uploadId: string }> }) {
  const { projectId, uploadId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.uploadStatus(request, projectId, uploadId))
}
