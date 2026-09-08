export {}

const [operation, ...arguments_] = process.argv.slice(2)

if (operation === 'database-initialization') {
  const { migrateDatabase } = await import('../../lib/db/client')
  migrateDatabase()
  process.stdout.write('ok')
} else if (operation === 'insight-reservation') {
  const [reportVersionId] = arguments_
  if (!reportVersionId) throw new Error('insight-reservation requires a report ID.')
  const { reserveReportInsightGeneration } = await import('../../lib/db/repository')
  process.stdout.write(reserveReportInsightGeneration(reportVersionId) ? 'reserved' : 'duplicate')
} else {
  throw new Error(`Unknown fixture operation: ${operation ?? ''}`)
}
