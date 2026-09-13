import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.prepareUpload(request, projectId))
}
