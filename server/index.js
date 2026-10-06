import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import { z } from 'zod'
import { mkdirSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const databasePath = resolve(root, process.env.DATABASE_PATH || 'data.sqlite')
const uploadDirectory = resolve(root, 'uploads')
mkdirSync(dirname(databasePath), { recursive: true })
mkdirSync(uploadDirectory, { recursive: true })
const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const schema = `
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('freelancer', 'client', 'admin')),
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    budget REAL NOT NULL CHECK (budget >= 0),
    deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'In Progress' CHECK (status IN ('Planning', 'In Progress', 'Completed', 'On Hold')),
    deliverables_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (client_id, title)
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High')),
    status TEXT NOT NULL DEFAULT 'To Do' CHECK (status IN ('To Do', 'In Progress', 'Completed')),
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL CHECK (amount > 0),
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Partially Paid', 'Paid')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount REAL NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT 'Bank transfer',
    paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS project_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`
db.exec(schema)

const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count
if (count === 0) {
  const seed = db.transaction(() => {
    const addClient = db.prepare('INSERT INTO clients (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)')
    const northstar = addClient.run('Maya Chen', 'Northstar Studio', 'maya@northstar.studio', '+1 (415) 555-0142', 'Prefers async updates on Tuesdays.').lastInsertRowid
    const fieldwork = addClient.run('Jordan Ellis', 'Fieldwork Co.', 'jordan@fieldwork.co', '+1 (212) 555-0175', 'Brand refresh and launch assets.').lastInsertRowid
    const passwordHash = bcrypt.hashSync('studio123', 10)
    const addUser = db.prepare('INSERT INTO users (name, email, password_hash, role, client_id) VALUES (?, ?, ?, ?, ?)')
    addUser.run('Alex Morgan', 'alex@studioflow.app', passwordHash, 'freelancer', null)
    addUser.run('Maya Chen', 'maya@northstar.studio', passwordHash, 'client', northstar)
    addUser.run('Studio Admin', 'admin@studioflow.app', passwordHash, 'admin', null)
    const addProject = db.prepare('INSERT INTO projects (client_id, title, description, budget, deadline, status, deliverables_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const website = addProject.run(northstar, 'Northstar website', 'A considered digital home for an independent creative studio.', 8400, '2026-11-18', 'In Progress', 'https://example.com/northstar-deliverables').lastInsertRowid
    const identity = addProject.run(fieldwork, 'Fieldwork identity', 'Visual identity system and a practical launch toolkit.', 5200, '2026-12-05', 'Planning', '').lastInsertRowid
    const addTask = db.prepare('INSERT INTO tasks (project_id, title, description, priority, status, due_date) VALUES (?, ?, ?, ?, ?, ?)')
    addTask.run(website, 'Creative direction', 'Align on the visual territory and reference set.', 'High', 'Completed', '2026-10-05')
    addTask.run(website, 'Design key pages', 'Homepage, about, and selected work templates.', 'High', 'In Progress', '2026-10-19')
    addTask.run(website, 'Build and handoff', 'Responsive build, QA, and launch notes.', 'Medium', 'To Do', '2026-11-14')
    addTask.run(identity, 'Discovery workshop', 'Map the audience, offer, and visual landscape.', 'Medium', 'To Do', '2026-10-14')
    addTask.run(identity, 'Identity explorations', 'Develop three distinct visual directions.', 'Low', 'To Do', '2026-10-29')
    const invoiceId = db.prepare('INSERT INTO invoices (project_id, number, amount, due_date, status) VALUES (?, ?, ?, ?, ?)').run(website, 'INV-2026-001', 2800, '2026-10-21', 'Partially Paid').lastInsertRowid
    db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, ?, ?, ?)').run(invoiceId, 1400, 'Bank transfer', '2026-09-26 10:30:00')
    const addLog = db.prepare('INSERT INTO project_history (project_id, user_id, action, details) VALUES (?, 1, ?, ?)')
    addLog.run(website, 'Project created', 'Northstar website was added to the workspace.')
    addLog.run(website, 'Task completed', 'Creative direction marked complete.')
    addLog.run(identity, 'Project created', 'Fieldwork identity was added to the workspace.')
  })
  seed()
}

const app = express()
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }))
app.use(express.json({ limit: '1mb' }))
app.use('/uploads', express.static(uploadDirectory))
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
    const allowedTypes = [
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]
    callback(allowedTypes.includes(file.mimetype) ? null : Object.assign(new Error('Upload a PDF, image, text, Word, or Excel file.'), { status: 400 }), allowedTypes.includes(file.mimetype))
  },
})
const secret = process.env.JWT_SECRET || 'local-development-secret-change-before-deploy'
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.')
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' })
  try {
    const payload = jwt.verify(token, secret)
    const user = db.prepare('SELECT id, name, email, role, client_id AS clientId FROM users WHERE id = ?').get(payload.sub)
    if (!user) return res.status(401).json({ error: 'Your session is no longer valid.' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Your session is no longer valid.' })
  }
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

function recordHistory(projectId, userId, action, details = '') {
  db.prepare('INSERT INTO project_history (project_id, user_id, action, details) VALUES (?, ?, ?, ?)').run(projectId, userId, action, details)
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

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.post('/api/auth/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(req.body.email)
  if (!user || !bcrypt.compareSync(req.body.password, user.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' })
  const token = jwt.sign({ sub: String(user.id) }, secret, { expiresIn: '12h' })
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }))

app.get('/api/clients', authenticate, (req, res) => {
  if (req.user.role === 'client') {
    return res.json(db.prepare('SELECT id, name, company, email, phone, notes, created_at AS createdAt FROM clients WHERE id = ?').all(req.user.clientId))
  }
  res.json(db.prepare(`SELECT c.*, c.created_at AS createdAt, COUNT(DISTINCT p.id) AS projectCount
    FROM clients c LEFT JOIN projects p ON p.client_id = c.id GROUP BY c.id ORDER BY c.name`).all())
})
app.post('/api/clients', authenticate, allow('freelancer', 'admin'), validate(clientInput), (req, res) => {
  const { name, company, email, phone, notes } = req.body
  const result = db.prepare('INSERT INTO clients (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)').run(name, company, email, phone, notes)
  res.status(201).json(db.prepare('SELECT *, created_at AS createdAt FROM clients WHERE id = ?').get(result.lastInsertRowid))
})
app.put('/api/clients/:id', authenticate, allow('freelancer', 'admin'), validate(clientInput), (req, res) => {
  const result = db.prepare('UPDATE clients SET name = ?, company = ?, email = ?, phone = ?, notes = ? WHERE id = ?').run(req.body.name, req.body.company, req.body.email, req.body.phone, req.body.notes, req.params.id)
  if (!result.changes) return res.status(404).json({ error: 'Client not found.' })
  res.json(db.prepare('SELECT *, created_at AS createdAt FROM clients WHERE id = ?').get(req.params.id))
})

app.get('/api/projects', authenticate, (req, res) => {
  const visible = visibleProjectClause(req.user)
  const rows = db.prepare(`SELECT p.*, p.client_id AS clientId, p.deliverables_url AS deliverablesUrl,
      p.created_at AS createdAt, c.name AS clientName, c.company AS clientCompany,
      COUNT(DISTINCT t.id) AS taskCount,
      SUM(CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END) AS completedTasks
    FROM projects p JOIN clients c ON c.id = p.client_id
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE 1 = 1 ${visible.sql} GROUP BY p.id ORDER BY p.deadline`).all(...visible.params)
  res.json(rows)
})
app.post('/api/projects', authenticate, allow('freelancer', 'admin'), validate(projectInput), (req, res) => {
  const body = req.body
  if (!db.prepare('SELECT id FROM clients WHERE id = ?').get(body.clientId)) return res.status(404).json({ error: 'Choose an existing client.' })
  try {
    const result = db.prepare(`INSERT INTO projects (client_id, title, description, budget, deadline, status, deliverables_url)
      VALUES (@clientId, @title, @description, @budget, @deadline, @status, @deliverablesUrl)`).run(body)
    recordHistory(result.lastInsertRowid, req.user.id, 'Project created', `${body.title} was added to the workspace.`)
    res.status(201).json(db.prepare('SELECT *, client_id AS clientId, deliverables_url AS deliverablesUrl FROM projects WHERE id = ?').get(result.lastInsertRowid))
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'This client already has a project with that title.' })
    throw error
  }
})
app.put('/api/projects/:id', authenticate, allow('freelancer', 'admin'), validate(projectInput), (req, res) => {
  const body = req.body
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id)
  if (!project) return res.status(404).json({ error: 'Project not found.' })
  try {
    db.prepare(`UPDATE projects SET client_id = @clientId, title = @title, description = @description,
      budget = @budget, deadline = @deadline, status = @status, deliverables_url = @deliverablesUrl WHERE id = @id`).run({ ...body, id: req.params.id })
    const action = project.status === body.status ? 'Project updated' : 'Project status changed'
    const details = project.status === body.status ? `${body.title} details updated.` : `${project.status} to ${body.status}`
    recordHistory(project.id, req.user.id, action, details)
    res.json(db.prepare('SELECT *, client_id AS clientId, deliverables_url AS deliverablesUrl FROM projects WHERE id = ?').get(req.params.id))
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'This client already has a project with that title.' })
    throw error
  }
})
app.post('/api/projects/:id/attachment', authenticate, allow('freelancer', 'admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' })
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id)
  if (!project) {
    unlinkSync(req.file.path)
    return res.status(404).json({ error: 'Project not found.' })
  }
  const url = `/uploads/${req.file.filename}`
  db.prepare('UPDATE projects SET deliverables_url = ? WHERE id = ?').run(url, project.id)
  recordHistory(project.id, req.user.id, 'Deliverable attached', basename(req.file.originalname, extname(req.file.originalname)))
  res.status(201).json({ url, name: req.file.originalname })
})

app.get('/api/tasks', authenticate, (req, res) => {
  const visible = visibleProjectClause(req.user)
  res.json(db.prepare(`SELECT t.*, t.project_id AS projectId, t.due_date AS dueDate,
      p.title AS projectTitle, c.name AS clientName
    FROM tasks t JOIN projects p ON p.id = t.project_id JOIN clients c ON c.id = p.client_id
    WHERE 1 = 1 ${visible.sql} ORDER BY CASE t.status WHEN 'In Progress' THEN 1 WHEN 'To Do' THEN 2 ELSE 3 END, t.due_date`).all(...visible.params))
})
app.post('/api/tasks', authenticate, allow('freelancer', 'admin'), validate(taskInput), (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.body.projectId)
  if (!project) return res.status(404).json({ error: 'Choose an existing project.' })
  const result = db.prepare(`INSERT INTO tasks (project_id, title, description, priority, due_date) VALUES (?, ?, ?, ?, ?)`)
    .run(req.body.projectId, req.body.title, req.body.description, req.body.priority, req.body.dueDate)
  recordHistory(req.body.projectId, req.user.id, 'Task added', req.body.title)
  res.status(201).json(db.prepare('SELECT *, project_id AS projectId, due_date AS dueDate FROM tasks WHERE id = ?').get(result.lastInsertRowid))
})
app.put('/api/tasks/:id/status', authenticate, validate(z.object({ status: z.enum(['To Do', 'In Progress', 'Completed']) })), (req, res) => {
  const task = db.prepare('SELECT t.*, p.client_id AS clientId FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(req.params.id)
  if (!task || (req.user.role === 'client' && task.clientId !== req.user.clientId)) return res.status(404).json({ error: 'Task not found.' })
  if (req.user.role === 'client' && req.body.status !== task.status) return res.status(403).json({ error: 'Clients can view task progress but cannot change it.' })
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(req.body.status, task.id)
  if (task.status !== req.body.status) recordHistory(task.project_id, req.user.id, 'Task status changed', `${task.title}: ${task.status} to ${req.body.status}`)
  res.json(db.prepare('SELECT *, project_id AS projectId, due_date AS dueDate FROM tasks WHERE id = ?').get(task.id))
})

app.get('/api/invoices', authenticate, (req, res) => {
  const visible = visibleProjectClause(req.user)
  res.json(db.prepare(`SELECT i.*, i.due_date AS dueDate, i.created_at AS createdAt,
      p.title AS projectTitle, p.client_id AS clientId, c.name AS clientName,
      COALESCE(SUM(pay.amount), 0) AS amountPaid
    FROM invoices i JOIN projects p ON p.id = i.project_id JOIN clients c ON c.id = p.client_id
    LEFT JOIN payments pay ON pay.invoice_id = i.id
    WHERE 1 = 1 ${visible.sql} GROUP BY i.id ORDER BY i.created_at DESC`).all(...visible.params))
})
app.post('/api/invoices', authenticate, allow('freelancer', 'admin'), validate(invoiceInput), (req, res) => {
  const project = db.prepare('SELECT id, title FROM projects WHERE id = ?').get(req.body.projectId)
  if (!project) return res.status(404).json({ error: 'Choose an existing project.' })
  if (!db.prepare("SELECT id FROM tasks WHERE project_id = ? AND status = 'Completed' LIMIT 1").get(project.id)) {
    return res.status(400).json({ error: 'Complete project work before creating an invoice.' })
  }
  const number = `INV-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`
  const result = db.prepare('INSERT INTO invoices (project_id, number, amount, due_date) VALUES (?, ?, ?, ?)')
    .run(project.id, number, req.body.amount, req.body.dueDate)
  recordHistory(project.id, req.user.id, 'Invoice created', `${number} for $${req.body.amount.toLocaleString()}`)
  res.status(201).json(db.prepare('SELECT *, due_date AS dueDate FROM invoices WHERE id = ?').get(result.lastInsertRowid))
})
app.post('/api/invoices/:id/payments', authenticate, allow('freelancer', 'admin'), validate(paymentInput), (req, res) => {
  const invoice = db.prepare('SELECT i.*, p.client_id AS clientId FROM invoices i JOIN projects p ON p.id = i.project_id WHERE i.id = ?').get(req.params.id)
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' })
  const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = ?').get(invoice.id).total
  if (req.body.amount > invoice.amount - paid + 0.005) return res.status(400).json({ error: 'Payment exceeds the remaining invoice balance.' })
  const addPayment = db.transaction(() => {
    db.prepare('INSERT INTO payments (invoice_id, amount, method) VALUES (?, ?, ?)').run(invoice.id, req.body.amount, req.body.method)
    const nextPaid = paid + req.body.amount
    const status = nextPaid >= invoice.amount - 0.005 ? 'Paid' : 'Partially Paid'
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoice.id)
    recordHistory(invoice.project_id, req.user.id, 'Payment recorded', `$${req.body.amount.toLocaleString()} received for ${invoice.number}.`)
  })
  addPayment()
  res.status(201).json({ message: 'Payment recorded.' })
})
app.get('/api/payments', authenticate, (req, res) => {
  const visible = visibleProjectClause(req.user)
  res.json(db.prepare(`SELECT pay.*, pay.paid_at AS paidAt, i.number AS invoiceNumber,
      i.project_id AS projectId, p.title AS projectTitle, c.name AS clientName
    FROM payments pay JOIN invoices i ON i.id = pay.invoice_id
    JOIN projects p ON p.id = i.project_id JOIN clients c ON c.id = p.client_id
    WHERE 1 = 1 ${visible.sql} ORDER BY pay.paid_at DESC`).all(...visible.params))
})
app.get('/api/history', authenticate, (req, res) => {
  const visible = visibleProjectClause(req.user)
  const projectFilter = req.query.projectId ? ' AND h.project_id = ?' : ''
  const params = [...visible.params, ...(req.query.projectId ? [req.query.projectId] : [])]
  res.json(db.prepare(`SELECT h.*, h.project_id AS projectId, h.created_at AS createdAt,
      p.title AS projectTitle, u.name AS userName
    FROM project_history h JOIN projects p ON p.id = h.project_id
    LEFT JOIN users u ON u.id = h.user_id
    WHERE 1 = 1 ${visible.sql}${projectFilter} ORDER BY h.created_at DESC, h.id DESC LIMIT 100`).all(...params))
})
app.get('/api/dashboard/summary', authenticate, (req, res) => {
  const visible = visibleProjectClause(req.user)
  const projectSql = `SELECT p.id, p.status, p.budget FROM projects p WHERE 1 = 1 ${visible.sql}`
  const projects = db.prepare(projectSql).all(...visible.params)
  const projectIds = projects.map((project) => project.id)
  const tasks = projectIds.length
    ? db.prepare(`SELECT status, COUNT(*) AS count FROM tasks WHERE project_id IN (${projectIds.map(() => '?').join(',')}) GROUP BY status`).all(...projectIds)
    : []
  const invoices = projectIds.length
    ? db.prepare(`SELECT i.amount, COALESCE(SUM(pay.amount), 0) AS paid FROM invoices i LEFT JOIN payments pay ON pay.invoice_id = i.id WHERE i.project_id IN (${projectIds.map(() => '?').join(',')}) GROUP BY i.id`).all(...projectIds)
    : []
  res.json({
    totalEarnings: invoices.reduce((sum, invoice) => sum + invoice.paid, 0),
    outstanding: invoices.reduce((sum, invoice) => sum + invoice.amount - invoice.paid, 0),
    activeProjects: projects.filter((project) => project.status === 'In Progress').length,
    totalProjects: projects.length,
    tasks: Object.fromEntries(['To Do', 'In Progress', 'Completed'].map((status) => [status, tasks.find((task) => task.status === status)?.count || 0])),
    projectProgress: projects.map((project) => ({ id: project.id, status: project.status, budget: project.budget })),
  })
})

if (process.env.NODE_ENV === 'production') {
  const clientBuild = resolve(root, '../dist')
  app.use(express.static(clientBuild))
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(resolve(clientBuild, 'index.html'))
    next()
  })
}

app.use((error, _req, res, _next) => {
  console.error(error)
  const status = error.status || (error instanceof multer.MulterError ? 400 : 500)
  res.status(status).json({ error: status < 500 ? error.message : 'Something went wrong. Please try again.' })
})

const port = Number(process.env.PORT || 3001)
app.listen(port, () => console.log(`Studioflow API listening on http://localhost:${port}`))
