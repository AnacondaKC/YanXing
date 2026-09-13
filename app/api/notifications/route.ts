import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runSubmissionRoute((runtime) => runtime.handlers.listNotifications(request))
}

export async function PATCH(request: Request) {
  return runSubmissionRoute((runtime) => runtime.handlers.patchNotifications(request))
}
