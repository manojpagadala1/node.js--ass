import assert from 'node:assert/strict'
import test from 'node:test'

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost/test'
const { compile } = await import('../server/database.js')

test('compiles positional parameters and PostgreSQL camel-case aliases', () => {
  assert.deepEqual(
    compile('SELECT client_id AS clientId FROM projects WHERE id = ? COLLATE NOCASE', [7]),
    {
      text: 'SELECT client_id AS "clientId" FROM projects WHERE id = $1',
      values: [7],
    },
  )
})

test('compiles named parameters in SQL occurrence order', () => {
  assert.deepEqual(
    compile('INSERT INTO projects (title, client_id) VALUES (@title, @clientId)', { clientId: 4, title: 'A project' }),
    {
      text: 'INSERT INTO projects (title, client_id) VALUES ($1, $2)',
      values: ['A project', 4],
    },
  )
})
