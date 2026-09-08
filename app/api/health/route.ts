import { NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const healthyStatus = 'ok'
const unhealthyStatus = 'unhealthy'
const noStoreHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
}

export async function GET() {
  try {
    pingDatabase()
    return healthResponse(healthyStatus, 200)
  } catch {
    return healthResponse(unhealthyStatus, 503)
  }
}

function pingDatabase() {
  const row = getDatabase().prepare('SELECT 1 AS ok').get() as { ok?: unknown } | undefined
  if (Number(row?.ok) !== 1) throw new Error('database ping failed')
}

function healthResponse(status: typeof healthyStatus | typeof unhealthyStatus, httpStatus: number) {
  return NextResponse.json({ status }, { status: httpStatus, headers: noStoreHeaders })
}
