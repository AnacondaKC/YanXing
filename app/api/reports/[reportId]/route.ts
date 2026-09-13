import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ reportId: string }> }

export async function GET(request: Request, context: Context) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.getReport(request, reportId))
}

export async function DELETE(request: Request, context: Context) {
  const { reportId } = await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.deleteReport(request, reportId))
}

export async function PATCH(request: Request, context: Context) {
  await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.patchReport(request))
}

export async function PUT(request: Request, context: Context) {
  await context.params
  return runSubmissionRoute((runtime) => runtime.handlers.putReport(request))
}
