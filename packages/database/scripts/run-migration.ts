import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

try {
  process.loadEnvFile?.(resolve(__dirname, '../../../.env'))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'deploy') throw new Error('Migration mode must be dev or deploy')

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required before running migrations')

const databaseName = new URL(databaseUrl).pathname.slice(1)
if (databaseName === 'online_learning') {
  throw new Error('Refusing to migrate protected legacy database online_learning; use the dedicated echoflow database')
}

const prismaCli = require.resolve('prisma/build/index.js')
const command = mode === 'dev' ? ['migrate', 'dev'] : ['migrate', 'deploy']
const result = spawnSync(process.execPath, [prismaCli, ...command, '--schema', resolve(__dirname, '../prisma/schema.prisma')], {
  cwd: resolve(__dirname, '..'),
  env: process.env,
  encoding: 'utf8',
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) throw new Error(`prisma migrate ${mode} failed with exit code ${result.status ?? 'unknown'}`)
