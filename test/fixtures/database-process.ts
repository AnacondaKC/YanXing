export {}

const operation = process.argv[2]

if (operation === 'database-initialization') {
  const { migrateDatabase } = await import('../../lib/db/client')
  migrateDatabase()
  process.stdout.write('ok')
} else if (operation === 'database-open') {
  const { getDatabase } = await import('../../lib/db/client')
  getDatabase()
  process.stdout.write('ok')
} else {
  throw new Error(`Unknown fixture operation: ${operation ?? ''}`)
}
