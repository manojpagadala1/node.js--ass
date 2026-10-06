import { Pool } from '@neondatabase/serverless'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured.')
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
})

export function compile(sql, input) {
  let values
  let text = sql

  if (!Array.isArray(input) && input && typeof input === 'object') {
    const names = []
    text = text.replace(/@([a-zA-Z][a-zA-Z0-9]*)/g, (_match, name) => {
      names.push(name)
      return `$${names.length}`
    })
    values = names.map((name) => input[name])
  } else {
    values = Array.isArray(input) ? input : [input]
    let index = 0
    text = text.replace(/\?/g, () => `$${++index}`)
  }

  text = text
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .replace(/\bAS\s+([a-zA-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g, 'AS "$1"')

  return { text, values }
}

function createDatabase(client) {
  async function query(sql, input = []) {
    const compiled = compile(sql, input)
    return client.query(compiled.text, compiled.values)
  }

  return {
    query,
    prepare(sql) {
      const parameters = (params) => (
        params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])
          ? params[0]
          : params
      )
      return {
        async get(...params) {
          const result = await query(sql, parameters(params))
          return result.rows[0]
        },
        async all(...params) {
          const result = await query(sql, parameters(params))
          return result.rows
        },
        async run(...params) {
          const statement = sql.trim().replace(/;$/, '')
          const isInsert = /^\s*INSERT\b/i.test(statement)
          const result = await query(
            isInsert && !/\bRETURNING\b/i.test(statement) ? `${statement} RETURNING id` : statement,
            parameters(params),
          )
          return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount }
        },
      }
    },
  }
}

export const db = createDatabase(pool)

export async function closeDatabase() {
  await pool.end()
}

export async function transaction(callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(createDatabase(client))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function initializeDatabase() {
  const statements = `
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('freelancer', 'client', 'admin')),
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      budget DOUBLE PRECISION NOT NULL CHECK (budget >= 0),
      deadline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'In Progress' CHECK (status IN ('Planning', 'In Progress', 'Completed', 'On Hold')),
      deliverables_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High')),
      status TEXT NOT NULL DEFAULT 'To Do' CHECK (status IN ('To Do', 'In Progress', 'Completed')),
      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Partially Paid', 'Paid')),
      created_at TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL DEFAULT 'Bank transfer',
      paid_at TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS project_history (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));
    CREATE UNIQUE INDEX IF NOT EXISTS projects_client_title_lower_unique ON projects (client_id, lower(title));
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_unique ON invoices (number);
  `.split(';').map((statement) => statement.trim()).filter(Boolean)
  for (const statement of statements) await pool.query(statement)
}
