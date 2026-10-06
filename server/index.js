import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import { handleUpload } from '@vercel/blob/client'
import { z } from 'zod'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, initializeDatabase, transaction } from './database.js'

const root = dirname(fileURLToPath(import.meta.url))
const uploadDirectory = resolve(root, 'uploads')
if (!process.env.VERCEL) mkdirSync(uploadDirectory, { recursive: true })

const app = express()
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }))
app.use((req, _res, next) => {
  const requestUrl = new URL(req.url, 'http://localhost')
  const vercelPath = requestUrl.searchParams.get('__path')
  if (vercelPath) {
    requestUrl.searchParams.delete('__path')
    req.url = `/api/${vercelPath}${requestUrl.search}`
  }
  next()
})
app.use(express.json({ limit: '1mb' }))

const allowedTypes = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, file, callback) => {
      const safeName = basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100)
      callback(null, `${randomUUID()}-${safeName}`)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const accepted = allowedTypes.includes(file.mimetype)
    callback(accepted ? null : Object.assign(new Error('Upload a PDF, image, text, Word, or Excel file.'), { status: 400 }), accepted)
  },
})
const localUpload = process.env.VERCEL
  ? (_req, res) => res.status(400).json({ error: 'Use the Vercel Blob upload endpoint.' })
  : upload.single('file')

const secret = process.env.JWT_SECRET || 'local-development-secret-change-before-deploy'
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.')
}

function invalidSession(res) {
  return res.status(401).json({ error: 'Your session is no longer valid.' })
}

async function getUserFromToken(token) {
  let payload
  try {
    payload = jwt.verify(token, secret)
  } catch {
    return null
  }
  return db.prepare('SELECT id, name, email, role, client_id AS clientId FROM users WHERE id = ?').get(payload.sub)
}

async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
  const user = await getUserFromToken(token)
  if (!user) return invalidSession(res)
  req.user = user
  next()
}

function allow(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' })
}

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) return res.status(400).json({ error: result.error.issues[0]?.message || 'Check the submitted information.' })
    req.body = result.data
    next()
  }
}

function recordHistory(projectId, userId, action, details = '', database = db) {
  return database.prepare('INSERT INTO project_history (project_id, user_id, action, details) VALUES (?, ?, ?, ?)').run(projectId, userId, action, details)
}

async function saveDeliverable(projectId, userId, url, name) {
  return transaction(async (database) => {
    const project = await database.prepare('SELECT deliverables_url FROM projects WHERE id = ? FOR UPDATE').get(projectId)
    if (!project) return false
    if (project.deliverables_url === url) return true
    await database.prepare('UPDATE projects SET deliverables_url = ? WHERE id = ?').run(url, projectId)
    await recordHistory(
      projectId,
      userId,
      'Deliverable attached',
      basename(name, extname(name)),
      database,
    )
    return true
  })
}

function visibleProjectClause(user) {
  return user.role === 'client' ? { sql: ' AND p.client_id = ?', params: [user.clientId] } : { sql: '', params: [] }
}

const clientInput = z.object({
  name: z.string().trim().min(2).max(100),
  company: z.string().trim().max(120).default(''),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().max(40).default(''),
  notes: z.string().trim().max(1000).default(''),
})
const projectInput = z.object({
  clientId: z.coerce.number().int().positive(),
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).default(''),
  budget: z.coerce.number().positive().max(10000000),
  deadline: z.string().date(),
  status: z.enum(['Planning', 'In Progress', 'Completed', 'On Hold']).default('Planning'),
  deliverablesUrl: z.string().trim().url().or(z.string().regex(/^\/uploads\/[a-zA-Z0-9._-]+$/)).or(z.literal('')).default(''),
})
const taskInput = z.object({
  projectId: z.coerce.number().int().positive(),
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(1000).default(''),
  priority: z.enum(['Low', 'Medium', 'High']).default('Medium'),
  dueDate: z.string().date().nullable().default(null),
})
const invoiceInput = z.object({
  projectId: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive().max(10000000),
  dueDate: z.string().date(),
})
const paymentInput = z.object({
  amount: z.coerce.number().positive().max(10000000),
  method: z.string().trim().min(2).max(50).default('Bank transfer'),
})

async function seedDemoData() {
  await transaction(async (database) => {
    await database.query('SELECT pg_advisory_xact_lock(735190241)')
    if (Number((await database.prepare('SELECT COUNT(*) AS count FROM users').get()).count) > 0) return

    if (process.env.NODE_ENV === 'production') {
      const bootstrap = z.object({
        email: z.string().email(),
        password: z.string().min(12),
        name: z.string().trim().min(2).max(100).default('Studio Admin'),
      }).safeParse({
        email: process.env.INITIAL_ADMIN_EMAIL,
        password: process.env.INITIAL_ADMIN_PASSWORD,
        name: process.env.INITIAL_ADMIN_NAME || 'Studio Admin',
      })
      if (!bootstrap.success) {
        throw new Error('Set INITIAL_ADMIN_EMAIL and a 12-character INITIAL_ADMIN_PASSWORD to initialize an empty production database.')
      }
      await database.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(bootstrap.data.name, bootstrap.data.email, bcrypt.hashSync(bootstrap.data.password, 10), 'admin')
      return
    }

    const addClient = database.prepare('INSERT INTO clients (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)')
    const northstar = (await addClient.run('Maya Chen', 'Northstar Studio', 'maya@northstar.studio', '+1 (415) 555-0142', 'Prefers async updates on Tuesdays.')).lastInsertRowid
    const fieldwork = (await addClient.run('Jordan Ellis', 'Fieldwork Co.', 'jordan@fieldwork.co', '+1 (212) 555-0175', 'Brand refresh and launch assets.')).lastInsertRowid
    const passwordHash = bcrypt.hashSync('studio123', 10)
    const addUser = database.prepare('INSERT INTO users (name, email, password_hash, role, client_id) VALUES (?, ?, ?, ?, ?)')
    await addUser.run('Alex Morgan', 'alex@studioflow.app', passwordHash, 'freelancer', null)
    await addUser.run('Maya Chen', 'maya@northstar.studio', passwordHash, 'client', northstar)
    await addUser.run('Studio Admin', 'admin@studioflow.app', passwordHash, 'admin', null)
    const addProject = database.prepare('INSERT INTO projects (client_id, title, description, budget, deadline, status, deliverables_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const website = (await addProject.run(northstar, 'Northstar website', 'A considered digital home for an independent creative studio.', 8400, '2026-11-18', 'In Progress', 'https://example.com/northstar-deliverables')).lastInsertRowid
    const identity = (await addProject.run(fieldwork, 'Fieldwork identity', 'Visual identity system and a practical launch toolkit.', 5200, '2026-12-05', 'Planning', '')).lastInsertRowid
    const addTask = database.prepare('INSERT INTO tasks (project_id, title, description, priority, status, due_date) VALUES (?, ?, ?, ?, ?, ?)')
    await addTask.run(website, 'Creative direction', 'Align on the visual territory and reference set.', 'High', 'Completed', '2026-10-05')
    await addTask.run(website, 'Design key pages', 'Homepage, about, and selected work templates.', 'High', 'In Progress', '2026-10-19')
    await addTask.run(website, 'Build and handoff', 'Responsive build, QA, and launch notes.', 'Medium', 'To Do', '2026-11-14')
    await addTask.run(identity, 'Discovery workshop', 'Map the audience, offer, and visual landscape.', 'Medium', 'To Do', '2026-10-14')
    await addTask.run(identity, 'Identity explorations', 'Develop three distinct visual directions.', 'Low', 'To Do', '2026-10-29')
    const invoiceId = (await database.prepare('INSERT INTO invoices (project_id, number, amount, due_date, status) VALUES (?, ?, ?, ?, ?)').run(website, 'INV-2026-001', 2800, '2026-10-21', 'Partially Paid')).lastInsertRowid
    await database.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, ?, ?, ?)').run(invoiceId, 1400, 'Bank transfer', '2026-09-26 10:30:00')
    const addLog = database.prepare('INSERT INTO project_history (project_id, user_id, action, details) VALUES (?, 1, ?, ?)')
    await addLog.run(website, 'Project created', 'Northstar website was added to the workspace.')
    await addLog.run(website, 'Task completed', 'Creative direction marked complete.')
    await addLog.run(identity, 'Project created', 'Fieldwork identity was added to the workspace.')
  })
}

await initializeDatabase()
await seedDemoData()

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.post('/api/auth/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(req.body.email)
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' })
  const token = jwt.sign({ sub: String(user.id) }, secret, { expiresIn: '12h' })
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }))

app.get('/api/clients', authenticate, async (req, res) => {
  if (req.user.role === 'client') {
    return res.json(await db.prepare('SELECT id, name, company, email, phone, notes, created_at AS createdAt FROM clients WHERE id = ?').all(req.user.clientId))
  }
  res.json(await db.prepare(`SELECT c.*, c.created_at AS createdAt, COUNT(DISTINCT p.id)::INTEGER AS projectCount
    FROM clients c LEFT JOIN projects p ON p.client_id = c.id GROUP BY c.id ORDER BY c.name`).all())
})
app.post('/api/clients', authenticate, allow('freelancer', 'admin'), validate(clientInput), async (req, res) => {
  const { name, company, email, phone, notes } = req.body
  const result = await db.prepare('INSERT INTO clients (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)').run(name, company, email, phone, notes)
  res.status(201).json(await db.prepare('SELECT *, created_at AS createdAt FROM clients WHERE id = ?').get(result.lastInsertRowid))
})
app.put('/api/clients/:id', authenticate, allow('freelancer', 'admin'), validate(clientInput), async (req, res) => {
  const result = await db.prepare('UPDATE clients SET name = ?, company = ?, email = ?, phone = ?, notes = ? WHERE id = ?').run(req.body.name, req.body.company, req.body.email, req.body.phone, req.body.notes, req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Client not found.' })
  res.json(await db.prepare('SELECT *, created_at AS createdAt FROM clients WHERE id = ?').get(req.params.id))
})

app.get('/api/projects', authenticate, async (req, res) => {
  const visible = visibleProjectClause(req.user)
  const rows = await db.prepare(`SELECT p.*, p.client_id AS clientId, p.deliverables_url AS deliverablesUrl,
      p.created_at AS createdAt, c.name AS clientName, c.company AS clientCompany,
      COUNT(DISTINCT t.id)::INTEGER AS taskCount,
      SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END)::INTEGER AS completedTasks
    FROM projects p JOIN clients c ON c.id = p.client_id
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE 1 = 1 ${visible.sql} GROUP BY p.id, c.name, c.company ORDER BY p.deadline`).all(...visible.params)
  res.json(rows)
})
app.post('/api/projects', authenticate, allow('freelancer', 'admin'), validate(projectInput), async (req, res) => {
  const body = req.body
  if (!await db.prepare('SELECT id FROM clients WHERE id = ?').get(body.clientId)) return res.status(404).json({ error: 'Choose an existing client.' })
  try {
    const result = await db.prepare(`INSERT INTO projects (client_id, title, description, budget, deadline, status, deliverables_url)
      VALUES (@clientId, @title, @description, @budget, @deadline, @status, @deliverablesUrl)`).run(body)
    await recordHistory(result.lastInsertRowid, req.user.id, 'Project created', `${body.title} was added to the workspace.`)
    res.status(201).json(await db.prepare('SELECT *, client_id AS clientId, deliverables_url AS deliverablesUrl FROM projects WHERE id = ?').get(result.lastInsertRowid))
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This client already has a project with that title.' })
    throw error
  }
})
app.put('/api/projects/:id', authenticate, allow('freelancer', 'admin'), validate(projectInput), async (req, res) => {
  const body = req.body
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  try {
    await db.prepare(`UPDATE projects SET client_id = @clientId, title = @title, description = @description,
      budget = @budget, deadline = @deadline, status = @status, deliverables_url = @deliverablesUrl WHERE id = @id`).run({ ...body, id: req.params.id })
    const action = project.status === body.status ? 'Project updated' : 'Project status changed'
    const details = project.status === body.status ? `${body.title} details updated.` : `${project.status} to ${body.status}`
    await recordHistory(project.id, req.user.id, action, details)
    res.json(await db.prepare('SELECT *, client_id AS clientId, deliverables_url AS deliverablesUrl FROM projects WHERE id = ?').get(req.params.id))
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This client already has a project with that title.' })
    throw error
  }
})

app.post('/api/uploads', async (req, res) => {
  try {
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
        const user = token ? await getUserFromToken(token) : null
        if (!user) throw Object.assign(new Error('Sign in to continue.'), { status: 401 })
        if (!['freelancer', 'admin'].includes(user.role)) throw Object.assign(new Error('You do not have permission to do that.'), { status: 403 })
        const payload = z.object({
          projectId: z.coerce.number().int().positive(),
          originalName: z.string().trim().min(1).max(255),
        }).safeParse(JSON.parse(clientPayload || '{}'))
        if (!payload.success) throw Object.assign(new Error('Invalid upload details.'), { status: 400 })
        const project = await db.prepare('SELECT id FROM projects WHERE id = ?').get(payload.data.projectId)
        if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 })

        return {
          allowedContentTypes: allowedTypes,
          maximumSizeInBytes: 10 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ projectId: project.id, userId: user.id, originalName: payload.data.originalName }),
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = z.object({
          projectId: z.number().int().positive(),
          userId: z.number().int().positive(),
          originalName: z.string().min(1).max(255),
        }).parse(JSON.parse(tokenPayload))
        const saved = await saveDeliverable(payload.projectId, payload.userId, blob.url, payload.originalName)
        if (!saved) throw new Error('Project not found for completed upload.')
      },
    })
    res.json(result)
  } catch (error) {
    console.error('Blob upload request failed:', error)
    res.status(error.status || 400).json({ error: error.status ? error.message : 'The file upload could not be completed.' })
  }
})

app.post('/api/projects/:id/attachment', authenticate, allow('freelancer', 'admin'), localUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' })
  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  const url = `/uploads/${req.file.filename}`
  await db.prepare('UPDATE projects SET deliverables_url = ? WHERE id = ?').run(url, project.id)
  await recordHistory(project.id, req.user.id, 'Deliverable attached', basename(req.file.originalname, extname(req.file.originalname)))
  res.status(201).json({ url, name: req.file.originalname })
})
app.post('/api/projects/:id/attachment/confirm', authenticate, allow('freelancer', 'admin'), validate(z.object({
  url: z.string().url().refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.endsWith('.blob.vercel-storage.com')
  }, 'The attachment must be stored in Vercel Blob.'),
  name: z.string().trim().min(1).max(255),
})), async (req, res) => {
  const saved = await saveDeliverable(Number(req.params.id), req.user.id, req.body.url, req.body.name)
  if (!saved) return res.status(404).json({ error: 'Project not found.' })
  res.status(200).json({ url: req.body.url, name: req.body.name })
})

app.use('/uploads', express.static(uploadDirectory))
app.get('/api/tasks', authenticate, async (req, res) => {
  const visible = visibleProjectClause(req.user)
  res.json(await db.prepare(`SELECT t.*, t.project_id AS projectId, t.due_date AS dueDate,
      p.title AS projectTitle, c.name AS clientName
    FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id
    WHERE 1 = 1 ${visible.sql} ORDER BY CASE t.status WHEN 'In Progress' THEN 1 WHEN 'To Do' THEN 2 ELSE 3 END, t.due_date`).all(...visible.params))
})
app.post('/api/tasks', authenticate, allow('freelancer', 'admin'), validate(taskInput), async (req, res) => {
  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').get(req.body.projectId)
  if (!project) return res.status(404).json({ error: 'Choose an existing project.' })
  const result = await db.prepare('INSERT INTO tasks (project_id, title, description, priority, due_date) VALUES (?, ?, ?, ?, ?)')
    .run(req.body.projectId, req.body.title, req.body.description, req.body.priority, req.body.dueDate)
  await recordHistory(req.body.projectId, req.user.id, 'Task added', req.body.title)
  res.status(201).json(await db.prepare('SELECT *, project_id AS projectId, due_date AS dueDate FROM tasks WHERE id = ?').get(result.lastInsertRowid))
})
app.put('/api/tasks/:id/status', authenticate, validate(z.object({ status: z.enum(['To Do', 'In Progress', 'Completed']) })), async (req, res) => {
  const task = await db.prepare('SELECT t.*, p.client_id AS clientId FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(req.params.id)
  if (!task || (req.user.role === 'client' && task.clientId !== req.user.clientId)) return res.status(404).json({ error: 'Task not found.' })
  if (req.user.role === 'client' && req.body.status !== task.status) return res.status(403).json({ error: 'Clients can view task progress but cannot change it.' })
  await db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(req.body.status, task.id)
  if (task.status !== req.body.status) await recordHistory(task.project_id, req.user.id, 'Task status changed', `${task.title}: ${task.status} to ${req.body.status}`)
  res.json(await db.prepare('SELECT *, project_id AS projectId, due_date AS dueDate FROM tasks WHERE id = ?').get(task.id))
})

app.get('/api/invoices', authenticate, async (req, res) => {
  const visible = visibleProjectClause(req.user)
  res.json(await db.prepare(`SELECT i.*, i.due_date AS dueDate, i.created_at AS createdAt,
      p.title AS projectTitle, p.client_id AS clientId, c.name AS clientName,
      COALESCE(SUM(pay.amount), 0) AS amountPaid
    FROM invoices i JOIN projects p ON p.id = i.project_id JOIN clients c ON c.id = p.client_id
    LEFT JOIN payments pay ON pay.invoice_id = i.id
    WHERE 1 = 1 ${visible.sql} GROUP BY i.id, p.title, p.client_id, c.name ORDER BY i.created_at DESC`).all(...visible.params))
})
app.post('/api/invoices', authenticate, allow('freelancer', 'admin'), validate(invoiceInput), async (req, res) => {
  const project = await db.prepare('SELECT id, title FROM projects WHERE id = ?').get(req.body.projectId)
  if (!project) return res.status(404).json({ error: 'Choose an existing project.' })
  if (!await db.prepare("SELECT id FROM tasks WHERE project_id = ? AND status = 'Completed' LIMIT 1").get(project.id)) {
    return res.status(400).json({ error: 'Complete project work before creating an invoice.' })
  }
  const number = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`
  const result = await db.prepare('INSERT INTO invoices (project_id, number, amount, due_date) VALUES (?, ?, ?, ?)')
    .run(project.id, number, req.body.amount, req.body.dueDate)
  await recordHistory(project.id, req.user.id, 'Invoice created', `${number} for $${req.body.amount.toLocaleString()}`)
  res.status(201).json(await db.prepare('SELECT *, due_date AS dueDate FROM invoices WHERE id = ?').get(result.lastInsertRowid))
})
app.post('/api/invoices/:id/payments', authenticate, allow('freelancer', 'admin'), validate(paymentInput), async (req, res) => {
  const result = await transaction(async (database) => {
    const invoice = await database.prepare('SELECT i.*, p.client_id AS clientId FROM invoices i JOIN projects p ON p.id = i.project_id WHERE i.id = ? FOR UPDATE').get(req.params.id)
    if (!invoice) return { status: 404, error: 'Invoice not found.' }
    const paid = Number((await database.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?').get(invoice.id)).total)
    if (req.body.amount > invoice.amount - paid + 0.005) {
      return { status: 400, error: 'Payment exceeds the remaining invoice balance.' }
    }
    await database.prepare('INSERT INTO payments (invoice_id, amount, method) VALUES (?, ?, ?)').run(invoice.id, req.body.amount, req.body.method)
    const nextPaid = paid + req.body.amount
    const status = nextPaid >= invoice.amount - 0.005 ? 'Paid' : 'Partially Paid'
    await database.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoice.id)
    await recordHistory(invoice.project_id, req.user.id, 'Payment recorded', `$${req.body.amount.toLocaleString()} received for ${invoice.number}.`, database)
    return null
  })
  if (result) return res.status(result.status).json({ error: result.error })
  res.status(201).json({ message: 'Payment recorded.' })
})
app.get('/api/payments', authenticate, async (req, res) => {
  const visible = visibleProjectClause(req.user)
  res.json(await db.prepare(`SELECT pay.*, pay.paid_at AS paidAt, i.number AS invoiceNumber,
      i.project_id AS projectId, p.title AS projectTitle, c.name AS clientName
    FROM payments pay JOIN invoices i ON i.id = pay.invoice_id
    JOIN projects p ON p.id = i.project_id JOIN clients c ON c.id = p.client_id
    WHERE 1 = 1 ${visible.sql} ORDER BY pay.paid_at DESC`).all(...visible.params))
})
app.get('/api/history', authenticate, async (req, res) => {
  const visible = visibleProjectClause(req.user)
  const projectFilter = req.query.projectId ? ' AND h.project_id = ?' : ''
  const params = [...visible.params, ...(req.query.projectId ? [req.query.projectId] : [])]
  res.json(await db.prepare(`SELECT h.*, h.project_id AS projectId, h.created_at AS createdAt,
      p.title AS projectTitle, u.name AS userName
    FROM project_history h JOIN projects p ON p.id = h.project_id
    LEFT JOIN users u ON u.id = h.user_id
    WHERE 1 = 1 ${visible.sql}${projectFilter} ORDER BY h.created_at DESC, h.id DESC LIMIT 100`).all(...params))
})
app.get('/api/dashboard/summary', authenticate, async (req, res) => {
  const visible = visibleProjectClause(req.user)
  const projectSql = `SELECT p.id, p.status, p.budget FROM projects p WHERE 1 = 1 ${visible.sql}`
  const projects = await db.prepare(projectSql).all(...visible.params)
  const projectIds = projects.map((project) => project.id)
  const tasks = projectIds.length
    ? await db.prepare(`SELECT status, COUNT(*)::INTEGER AS count FROM tasks WHERE project_id IN (${projectIds.map(() => '?').join(',')}) GROUP BY status`).all(...projectIds)
    : []
  const invoices = projectIds.length
    ? await db.prepare(`SELECT i.amount, COALESCE(SUM(pay.amount), 0) AS paid FROM invoices i LEFT JOIN payments pay ON pay.invoice_id = i.id WHERE i.project_id IN (${projectIds.map(() => '?').join(',')}) GROUP BY i.id`).all(...projectIds)
    : []
  res.json({
    totalEarnings: invoices.reduce((sum, invoice) => sum + Number(invoice.paid), 0),
    outstanding: invoices.reduce((sum, invoice) => sum + invoice.amount - Number(invoice.paid), 0),
    activeProjects: projects.filter((project) => project.status === 'In Progress').length,
    totalProjects: projects.length,
    tasks: Object.fromEntries(['To Do', 'In Progress', 'Completed'].map((status) => [status, tasks.find((task) => task.status === status)?.count || 0])),
    projectProgress: projects.map((project) => ({ id: project.id, status: project.status, budget: project.budget })),
  })
})

app.use((error, _req, res, _next) => {
  console.error(error)
  const status = error.status || (error instanceof multer.MulterError ? 400 : 500)
  res.status(status).json({ error: status < 500 ? error.message : 'Something went wrong. Please try again.' })
})

const port = Number(process.env.PORT || 3001)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => console.log(`Studioflow API listening on http://localhost:${port}`))
}

export default app
