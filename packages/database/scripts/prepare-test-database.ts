import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Client } from 'pg'

/**
 * Create a fresh, disposable PostgreSQL test database and apply the full
 * forward migration chain to it. The database name MUST match the
 * ^echoflow_[A-Za-z0-9_]+_test$ pattern; anything else is refused.
 * This function never touches business databases, volumes or containers.
 */
export async function prepareTestDatabase(requestedDatabaseName?: string): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL
    ?? 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g2_integration_test'
  const selectedUrl = new URL(databaseUrl)
  if (requestedDatabaseName) selectedUrl.pathname = `/${requestedDatabaseName}`
  const databaseName = selectedUrl.pathname.slice(1)

  if (!/^echoflow_[A-Za-z0-9_]+_test$/.test(databaseName)) {
    throw new Error(`Refusing to prepare non-test database: ${databaseName}`)
  }

  const adminUrl = new URL(selectedUrl)
  adminUrl.pathname = '/postgres'
  const admin = new Client({ connectionString: adminUrl.toString() })

  try {
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.end()
  }

  const schemaPath = resolve(__dirname, '../prisma/schema.prisma')
  const prismaCli = require.resolve('prisma/build/index.js')
  const migration = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', schemaPath],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: selectedUrl.toString() },
      encoding: 'utf8',
      stdio: 'inherit',
    },
  )

  if (migration.error) throw migration.error
  if (migration.status !== 0) throw new Error(`prisma migrate deploy failed with exit code ${migration.status ?? 'unknown'}`)
  console.log(`Prepared isolated PostgreSQL test database: ${databaseName}`)
}

if (require.main === module) {
  void prepareTestDatabase(process.argv[2])
}
