import 'dotenv/config'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { put } from '@vercel/blob'
import { closeDatabase, db, initializeDatabase, transaction } from '../server/database.js'

const tables = ['clients', 'users', 'projects', 'tasks', 'invoices', 'payments', 'project_history']
const demoAccounts = {
  'alex@studioflow.app': 'MIGRATION_FREELANCER_PASSWORD',
  'maya@northstar.studio': 'MIGRATION_CLIENT_PASSWORD',
  'admin@studioflow.app': 'MIGRATION_ADMIN_PASSWORD',
}
const sqlitePath = resolve(process.env.SQLITE_DATABASE_PATH || 'server/data.sqlite')
const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true })

try {
  await initializeDatabase()
  const rowCounts = Object.fromEntries(tables.map((table) => [table, sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]))
  const replacementPasswords = new Map()
  for (const user of sqlite.prepare('SELECT email, password_hash FROM users').all()) {
    const variable = demoAccounts[user.email.toLowerCase()]
    if (!variable || !bcrypt.compareSync('studio123', user.password_hash)) continue
    const password = process.env[variable]
    if (!password || password.length < 12) {
      throw new Error(`Set ${variable} to a unique password of at least 12 characters before migration.`)
    }
    replacementPasswords.set(user.email.toLowerCase(), password)
  }
  if (new Set(replacementPasswords.values()).size !== replacementPasswords.size) {
    throw new Error('Set a different migration password for each seeded demo account.')
  }
  const sqliteProjects = sqlite.prepare('SELECT id, deliverables_url FROM projects').all()
  const targetCounts = await Promise.all(tables.map(async (table) => {
    const { count } = await db.prepare(`SELECT COUNT(*)::INTEGER AS count FROM ${table}`).get()
    return [table, count]
  }))
  const occupiedTable = targetCounts.find(([, count]) => count !== 0)
  if (occupiedTable) {
    throw new Error(`Neon table "${occupiedTable[0]}" is not empty. Use a fresh Neon database before importing SQLite data.`)
  }

  const migratedUploads = new Map()
  const contentTypes = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  for (const project of sqliteProjects) {
    const match = /^\/uploads\/([a-zA-Z0-9._-]+)$/.exec(project.deliverables_url)
    if (!match || migratedUploads.has(project.deliverables_url)) continue
    const filename = match[1]
    const filePath = resolve('server/uploads', filename)
    if (!existsSync(filePath)) throw new Error(`Cannot migrate "${filename}": the local upload file is missing.`)
    if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is required to migrate existing uploads.')
    const contentType = contentTypes[extname(filename).toLowerCase()]
    if (!contentType) throw new Error(`Cannot migrate "${filename}": its file type is not supported.`)
    const blob = await put(`${randomUUID()}-${filename}`, readFileSync(filePath), {
      access: 'public',
      addRandomSuffix: true,
      contentType,
      multipart: true,
    })
    migratedUploads.set(project.deliverables_url, blob.url)
  }

  await transaction(async (database) => {
    for (const table of tables) {
      const { count } = await database.prepare(`SELECT COUNT(*)::INTEGER AS count FROM ${table}`).get()
      if (count !== 0) {
        throw new Error(`Neon table "${table}" is not empty. Use a fresh Neon database before importing SQLite data.`)
      }
    }

    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all()
      if (rows.length) {
        const columns = Object.keys(rows[0])
        const quotedColumns = columns.map((column) => `"${column}"`).join(', ')
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ')
        for (const row of rows) {
          if (table === 'users' && replacementPasswords.has(row.email.toLowerCase())) {
            row.password_hash = bcrypt.hashSync(replacementPasswords.get(row.email.toLowerCase()), 10)
          }
          if (table === 'projects' && migratedUploads.has(row.deliverables_url)) {
            row.deliverables_url = migratedUploads.get(row.deliverables_url)
          }
          await database.query(
            `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders})`,
            columns.map((column) => row[column]),
          )
        }
      }
      const { count } = await database.prepare(`SELECT COUNT(*)::INTEGER AS count FROM "${table}"`).get()
      if (count !== rowCounts[table]) {
        throw new Error(`Import verification failed for "${table}": expected ${rowCounts[table]}, found ${count}.`)
      }
    }

    for (const table of tables) {
      await database.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM "${table}"`,
      )
    }
  })

  console.log('SQLite data imported and verified:')
  for (const [table, count] of Object.entries(rowCounts)) console.log(`  ${table}: ${count}`)
} finally {
  sqlite.close()
  await closeDatabase()
}
