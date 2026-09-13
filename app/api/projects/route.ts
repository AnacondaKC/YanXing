import { runSubmissionRoute } from '@/lib/reports/server-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runSubmissionRoute((runtime) => runtime.handlers.listProjects(request))
}

export async function POST(request: Request) {
  return runSubmissionRoute((runtime) => runtime.handlers.createProject(request))
}
