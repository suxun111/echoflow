import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Client } from 'pg'

async function main() {
  const databaseUrl = process.env.TEST_DATABASE_URL
    ?? 'postgresql://online_learning:online_learning@localhost:5432/echoflow_g1_integration_test'
  const parsed = new URL(databaseUrl)
  const databaseName = parsed.pathname.slice(1)

  if (!/^[A-Za-z0-9_]+$/.test(databaseName) || !databaseName.endsWith('_test')) {
    throw new Error(`Refusing to prepare non-test database: ${databaseName}`)
  }

  const adminUrl = new URL(databaseUrl)
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
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      stdio: 'inherit',
    },
  )

  if (migration.error) throw migration.error
  if (migration.status !== 0) throw new Error(`prisma migrate deploy failed with exit code ${migration.status ?? 'unknown'}`)
  console.log(`Prepared isolated PostgreSQL test database: ${databaseName}`)
}

void main()
