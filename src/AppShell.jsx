import { useEffect, useState } from 'react'
import {
  Activity, ArrowDownLeft, ArrowUpRight, Bell, BriefcaseBusiness, CalendarDays,
  Check, ChevronDown, CircleDollarSign, Clock3, FileText, FolderKanban,
  LayoutDashboard, LogOut, Menu, MoreHorizontal, Plus, Search, Settings2,
  Users, X,
} from 'lucide-react'
import { upload as uploadBlob } from '@vercel/blob/client'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || '/api'
const NAV = [
  ['dashboard', 'Overview', LayoutDashboard], ['projects', 'Projects', FolderKanban],
  ['tasks', 'Task board', Check], ['clients', 'Clients', Users],
  ['invoices', 'Invoices', FileText], ['payments', 'Payments', CircleDollarSign],
  ['history', 'Activity', Activity],
]
const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)
const date = (s) => s ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${s.slice(0, 10)}T12:00:00`)) : 'No deadline'

async function api(path, token, options = {}) {
  const multipart = options.body instanceof FormData
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...(options.body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.')
  return body
}

export default function AppShell() {
  const [token, setToken] = useState(() => sessionStorage.getItem('studioflow-token') || '')
  const [user, setUser] = useState(null)
  const [page, setPage] = useState('dashboard')
  const [data, setData] = useState({ clients: [], projects: [], tasks: [], invoices: [], payments: [], history: [], summary: null })
  const [loading, setLoading] = useState(Boolean(sessionStorage.getItem('studioflow-token')))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState('')
  const [selected, setSelected] = useState(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const canManage = user?.role !== 'client'

  useEffect(() => {
    if (!token) return undefined
    let current = true
    Promise.all(['/auth/me', '/clients', '/projects', '/tasks', '/invoices', '/payments', '/history', '/dashboard/summary'].map((path) => api(path, token)))
      .then(([profile, clients, projects, tasks, invoices, payments, history, summary]) => {
        if (!current) return
        setUser(profile.user)
        setData({ clients, projects, tasks, invoices, payments, history, summary })
        setError('')
      }).catch((issue) => {
        if (!current) return
        setError(issue.message)
        if (issue.message.includes('session')) { sessionStorage.removeItem('studioflow-token'); setToken(''); setUser(null) }
      }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [token, refresh])

  function flash(message) {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3000)
  }

  async function login(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const result = await api('/auth/login', '', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) })
      setLoading(true)
      sessionStorage.setItem('studioflow-token', result.token)
      setUser(result.user)
      setToken(result.token)
    } catch (issue) { setError(issue.message) } finally { setBusy(false) }
  }

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const formData = new FormData(event.currentTarget)
    const file = formData.get('file')
    const form = Object.fromEntries([...formData.entries()].filter(([key]) => key !== 'file'))
    let attachmentProject = null
    try {
      let path
      let method = 'POST'
      let body = form
      if (modal.endsWith('client')) {
        path = modal === 'edit-client' ? `/clients/${selected.id}` : '/clients'
        if (modal === 'edit-client') method = 'PUT'
      } else if (modal.endsWith('project')) {
        path = modal === 'edit-project' ? `/projects/${selected.id}` : '/projects'
        if (modal === 'edit-project') method = 'PUT'
        body = { ...form, clientId: Number(form.clientId), budget: Number(form.budget), deliverablesUrl: form.deliverablesUrl || form.existingDeliverableUrl || '' }
        delete body.existingDeliverableUrl
        attachmentProject = await api(path, token, { method, body: JSON.stringify(body) })
      } else if (modal === 'task') {
        path = '/tasks'; body = { ...form, projectId: Number(form.projectId), dueDate: form.dueDate || null }
      } else if (modal === 'invoice') {
        path = '/invoices'; body = { ...form, projectId: Number(form.projectId), amount: Number(form.amount) }
      } else {
        path = `/invoices/${form.invoiceId}/payments`; body = { amount: Number(form.amount), method: form.method }
      }
      if (!attachmentProject) await api(path, token, { method, body: JSON.stringify(body) })
      if (attachmentProject && file instanceof File && file.size) {
        if (import.meta.env.PROD) {
          const blob = await uploadBlob(file.name, file, {
            access: 'public',
            handleUploadUrl: `${API_URL}/uploads`,
            clientPayload: JSON.stringify({ projectId: attachmentProject.id, originalName: file.name }),
            headers: { Authorization: `Bearer ${token}` },
            multipart: true,
          })
          await api(`/projects/${attachmentProject.id}/attachment/confirm`, token, {
            method: 'POST',
            body: JSON.stringify({ url: blob.url, name: file.name }),
          })
        } else {
          const attachment = new FormData()
          attachment.append('file', file)
          await api(`/projects/${attachmentProject.id}/attachment`, token, { method: 'POST', body: attachment })
        }
      }
      setModal(''); setSelected(null); setLoading(true); setRefresh((value) => value + 1); flash('Changes saved.')
    } catch (issue) {
      if (attachmentProject) {
        setModal('edit-project')
        setSelected(attachmentProject)
        setLoading(true)
        setRefresh((value) => value + 1)
        setError(`Project saved. The attachment did not upload: ${issue.message} Reopen the project to retry.`)
      } else setError(issue.message)
    } finally { setBusy(false) }
  }

  async function updateTask(task, status) {
    try {
      await api(`/tasks/${task.id}/status`, token, { method: 'PUT', body: JSON.stringify({ status }) })
      setLoading(true); setRefresh((value) => value + 1); flash('Task status updated.')
    } catch (issue) { setError(issue.message) }
  }

  function openModal(kind, item = null) { setSelected(item); setModal(kind); setError('') }
  function signOut() { sessionStorage.removeItem('studioflow-token'); setToken(''); setUser(null); setPage('dashboard'); setLoading(false) }
  const searchIn = (rows, fields) => rows.filter((row) => fields.some((field) => String(row[field] || '').toLowerCase().includes(search.toLowerCase())))

  if (!token) return <Login onSubmit={login} busy={busy} error={error} />
  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <a className="brand" href="#overview" onClick={() => setPage('dashboard')}><span className="brand-mark"><span /></span><span>studioflow<small>FREELANCE OS</small></span></a>
      <div className="workspace-label">WORKSPACE <button type="button" title="Workspace settings"><Settings2 size={14} /></button></div>
      <div className="workspace-switch"><span className="workspace-avatar">AM</span><span className="workspace-name">Alex Morgan<small>Independent studio</small></span><ChevronDown size={15} /></div>
      <p className="nav-caption">MANAGE</p>
      <nav className="main-nav" aria-label="Main navigation">{NAV.map(([id, label, Icon]) => <button type="button" key={id} className={`nav-link ${page === id ? 'nav-active' : ''}`} onClick={() => { setPage(id); setMobileOpen(false) }}><Icon size={18} /><span>{label}</span>{id === 'tasks' && <i className="nav-count">{data.tasks.filter((task) => task.status !== 'Completed').length}</i>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="plan-note"><BriefcaseBusiness size={16} /><strong>Your studio, in sync.</strong><span>Everything in one calm place.</span></div><button type="button" className="profile-row" onClick={signOut} title="Sign out"><span className="profile-avatar">{initials(user?.name)}</span><span className="profile-name">{user?.name}<small>{user?.role}</small></span><LogOut size={16} /></button></div>
    </aside>
    {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <main className="main-area">
      <header className="topbar"><div className="topbar-left"><button type="button" className="icon-button mobile-menu" title="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></button><div className="breadcrumb"><span>Workspace</span><i>/</i><strong>{NAV.find(([id]) => id === page)?.[1]}</strong></div></div><div className="topbar-actions"><label className="search-box"><Search size={16} /><input placeholder="Search anything..." aria-label="Search workspace" value={search} onChange={(event) => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label><button className="icon-button notification-button" title="Notifications"><Bell size={18} /><i /></button><span className="top-avatar">{initials(user?.name)}</span></div></header>
      <div className="page-content">
        {error && <div className="alert-banner" role="alert"><span>{error}</span><button type="button" title="Dismiss" onClick={() => setError('')}><X size={15} /></button></div>}
        {loading ? <div className="loading-state"><span className="loader" />Loading your workspace</div> : <>
          {page === 'dashboard' && <Dashboard data={data} navigate={setPage} open={openModal} canManage={canManage} />}
          {page === 'clients' && <Clients clients={searchIn(data.clients, ['name', 'company', 'email'])} open={openModal} canManage={canManage} />}
          {page === 'projects' && <Projects projects={searchIn(data.projects, ['title', 'clientName', 'status'])} open={openModal} canManage={canManage} />}
          {page === 'tasks' && <Tasks tasks={searchIn(data.tasks, ['title', 'projectTitle', 'clientName'])} projects={data.projects} open={openModal} update={updateTask} canManage={canManage} />}
          {page === 'invoices' && <Invoices invoices={searchIn(data.invoices, ['number', 'projectTitle', 'clientName', 'status'])} open={openModal} canManage={canManage} />}
          {page === 'payments' && <Payments payments={searchIn(data.payments, ['invoiceNumber', 'projectTitle', 'clientName', 'method'])} />}
          {page === 'history' && <History history={searchIn(data.history, ['action', 'details', 'projectTitle', 'userName'])} />}
        </>}
      </div>
      <footer className="app-footer"><span>© 2026 Studioflow</span><span>Made for independent work <b>✳</b></span></footer>
    </main>
    {notice && <div className="toast"><Check size={16} />{notice}</div>}
    {modal && <Editor type={modal} item={selected} clients={data.clients} projects={data.projects} invoices={data.invoices} close={() => { setModal(''); setSelected(null) }} submit={submit} busy={busy} error={error} />}
  </div>
}

function initials(name = '') { return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function Login({ onSubmit, busy, error }) {
  return <main className="login-screen"><section className="login-panel"><a className="brand login-brand" href="#signin"><span className="brand-mark"><span /></span><span>studioflow<small>FREELANCE OS</small></span></a><div className="login-copy"><span className="eyebrow">YOUR INDEPENDENT STUDIO, ORGANIZED</span><h1>Make room for<br />the good work.</h1><p>Clients, projects, tasks and getting paid. All the moving parts, finally moving together.</p></div><div className="login-art" aria-hidden="true"><div className="art-paper"><i /><i /><i /><i /></div><div className="art-check"><Check size={23} /></div><span className="art-dot dot-one" /><span className="art-dot dot-two" /></div><p className="login-footnote">A little more focus. A lot less follow-up.</p></section><section className="login-form-panel"><form className="login-form" onSubmit={onSubmit}><span className="eyebrow">WELCOME BACK</span><h2>Sign in to your workspace</h2><p className="login-intro">Your next good thing is already in progress.</p>{error && <div className="form-error" role="alert">{error}</div>}<label>Email address<input type="email" name="email" autoComplete="username" defaultValue="alex@studioflow.app" required /></label><label>Password<input type="password" name="password" autoComplete="current-password" defaultValue="studio123" required /></label><button className="button button-primary login-submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}<ArrowUpRight size={17} /></button><p className="demo-hint">Demo access is ready to explore. <span>Freelancer account</span></p></form><div className="login-corner">STUDIOFLOW <i>·</i> 01 / 01</div></section></main>
}

function Heading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>
}
function AddButton({ children, onClick }) { return <button type="button" className="button button-primary" onClick={onClick}><Plus size={16} />{children}</button> }
function Badge({ status }) { return <span className={`status-badge status-${status.toLowerCase().replaceAll(' ', '-')}`}><i />{status}</span> }
function Empty({ title, detail }) { return <div className="empty-state"><span className="empty-mark"><FolderKanban size={19} /></span><strong>{title}</strong><p>{detail}</p></div> }
function Metric({ label, value, note, icon: Icon, tone }) { return <article className={`metric-card metric-${tone}`}><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={17} /></span></div><strong>{value}</strong><small>{note}</small></article> }
function Dashboard({ data, navigate, open, canManage }) {
  const stats = data.summary || { tasks: {}, totalEarnings: 0, outstanding: 0, activeProjects: 0 }
  const total = Object.values(stats.tasks || {}).reduce((sum, n) => sum + n, 0)
  const percent = total ? Math.round((stats.tasks.Completed / total) * 100) : 0
  const current = data.projects.filter((project) => project.status !== 'Completed').sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 3)
  return <><Heading eyebrow="THURSDAY, OCTOBER 1, 2026" title={<>A clear day for<br className="heading-break" /> <em>good work.</em></>} description="Here’s what’s happening across your studio." action={canManage && <AddButton onClick={() => open('project')}>New project</AddButton>} /><section className="metric-grid"><Metric label="Collected this year" value={money(stats.totalEarnings)} note={`${money(stats.outstanding)} still outstanding`} icon={ArrowDownLeft} tone="mint" /><Metric label="Active projects" value={String(stats.activeProjects).padStart(2, '0')} note={`${data.clients.length} thoughtful clients`} icon={FolderKanban} tone="peach" /><Metric label="Tasks completed" value={`${percent}%`} note={`${stats.tasks.Completed || 0} of ${total} tasks`} icon={Check} tone="blue" /></section>
    <div className="dashboard-grid"><section className="surface project-surface"><div className="section-heading"><div><span className="eyebrow">IN MOTION</span><h2>Current projects</h2></div><button className="text-link" onClick={() => navigate('projects')}>All projects <ArrowUpRight size={15} /></button></div>{current.length ? <div className="project-list">{current.map((p, i) => { const done = p.taskCount ? Math.round(p.completedTasks / p.taskCount * 100) : 0; return <div className="project-row" key={p.id}><span className={`project-index index-${i}`}>0{i + 1}</span><div className="project-title-block"><strong>{p.title}</strong><span>{p.clientName} <i /> {p.taskCount} tasks</span></div><div className="project-progress"><div><span style={{ width: `${done}%` }} /></div><small>{done}%</small></div><div className="project-budget"><strong>{money(p.budget)}</strong><span>PROJECT VALUE</span></div><Badge status={p.status} /></div> })}</div> : <Empty title="A fresh page." detail="Create your first project to see it here." />}</section>
    <section className="surface progress-surface"><div className="section-heading"><div><span className="eyebrow">THE BIG PICTURE</span><h2>Task progress</h2></div><button className="icon-button quiet-button" title="View task board" onClick={() => navigate('tasks')}><MoreHorizontal size={20} /></button></div><div className="progress-number"><strong>{String(percent).padStart(2, '0')}<small>%</small></strong><span>of all tasks completed</span></div><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><div className="progress-legend"><span><i className="legend-dot green-dot" />Completed <b>{stats.tasks.Completed || 0}</b></span><span><i className="legend-dot orange-dot" />In progress <b>{stats.tasks['In Progress'] || 0}</b></span><span><i className="legend-dot gray-dot" />To do <b>{stats.tasks['To Do'] || 0}</b></span></div></section></div>
    <div className="dashboard-grid lower-grid"><section className="surface deadline-surface"><div className="section-heading"><div><span className="eyebrow">UP NEXT</span><h2>On the horizon</h2></div><CalendarDays size={18} /></div>{current.length ? <div className="deadline-list">{current.map((p) => <div className="deadline-row" key={p.id}><span className="deadline-icon"><Clock3 size={17} /></span><div><strong>{p.title}</strong><small>{p.clientName}</small></div><time>{date(p.deadline)}</time></div>)}</div> : <Empty title="No deadlines looming." detail="The calendar is yours." />}</section><section className="quick-actions"><span className="eyebrow">A LITTLE MOMENTUM</span><h2>Keep things<br /><em>moving.</em></h2><p>Small steps make good projects.</p>{canManage && <div className="quick-action-buttons"><button onClick={() => open('task')}><Check size={16} />Add a task<ArrowUpRight size={15} /></button><button onClick={() => open('invoice')}><FileText size={16} />Create an invoice<ArrowUpRight size={15} /></button></div>}<span className="quick-spark">✳</span></section></div></>
}

function Projects({ projects, open, canManage }) {
  return <><Heading eyebrow="THE WORK, IN VIEW" title="Projects" description="Every brief, milestone, and handoff in one place." action={canManage && <AddButton onClick={() => open('project')}>New project</AddButton>} /><section className="surface table-surface"><div className="table-top"><div><h2>All projects <span className="count-pill">{projects.length}</span></h2><p>Track the work from first brief to final handoff.</p></div><span className="table-filter"><i />All projects</span></div><div className="table-scroll"><table><thead><tr><th>PROJECT</th><th>CLIENT</th><th>STATUS</th><th>PROGRESS</th><th>BUDGET</th><th>DEADLINE</th>{canManage && <th />}</tr></thead><tbody>{projects.map((p) => { const progress = p.taskCount ? Math.round(p.completedTasks / p.taskCount * 100) : 0; return <tr key={p.id}><td><strong className="table-primary">{p.title}</strong><span className="table-secondary">{p.description || 'No project notes'}</span>{p.deliverablesUrl && <a className="table-secondary deliverable-link" href={p.deliverablesUrl} target="_blank" rel="noreferrer">Open deliverable <ArrowUpRight size={11} /></a>}</td><td>{p.clientName}</td><td><Badge status={p.status} /></td><td><div className="table-progress"><div><span style={{ width: `${progress}%` }} /></div><small>{progress}%</small></div></td><td>{money(p.budget)}</td><td>{date(p.deadline)}</td>{canManage && <td><button className="icon-button row-action" title="Edit project" onClick={() => open('edit-project', p)}><MoreHorizontal size={18} /></button></td>}</tr> })}</tbody></table>{!projects.length && <Empty title="No projects found." detail="Add a project or adjust your search." />}</div></section></>
}

function Clients({ clients, open, canManage }) {
  return <><Heading eyebrow="THE PEOPLE BEHIND THE WORK" title="Clients" description="Good work starts with good relationships." action={canManage && <AddButton onClick={() => open('client')}>Add client</AddButton>} /><section className="client-grid">{clients.map((c, i) => <article className="client-card" key={c.id}><div className="client-card-head"><span className={`client-avatar client-color-${i % 4}`}>{initials(c.name)}</span>{canManage && <button className="icon-button row-action" title="Edit client" onClick={() => open('edit-client', c)}><MoreHorizontal size={18} /></button>}</div><h2>{c.name}</h2><p>{c.company || 'Independent client'}</p><div className="client-contact"><span>{c.email}</span>{c.phone && <span>{c.phone}</span>}</div><div className="client-card-foot"><span><FolderKanban size={15} />{c.projectCount || 0} projects</span><span>CLIENT SINCE {date(c.createdAt).toUpperCase()}</span></div></article>)}{!clients.length && <Empty title="Your client list starts here." detail="Add a client to keep the important details close." />}</section></>
}

function Tasks({ tasks, projects, open, update, canManage }) {
  const statuses = ['To Do', 'In Progress', 'Completed']
  return <><Heading eyebrow="ONE THING AT A TIME" title="Task board" description="A little structure for all the good details." action={canManage && <AddButton onClick={() => open('task')}>Add task</AddButton>} /><div className="kanban-board">{statuses.map((status, i) => { const list = tasks.filter((task) => task.status === status); return <section className={`kanban-column column-${i}`} key={status}><div className="kanban-heading"><i className={`kanban-marker marker-${i}`} /><h2>{status}</h2><span className="kanban-count">{list.length}</span><button className="icon-button quiet-button" title={`Add task to ${status}`} onClick={() => open('task')} disabled={!canManage}><Plus size={17} /></button></div><div className="kanban-cards">{list.map((task) => <article className="task-card" key={task.id}><div className="task-card-top"><span className={`priority priority-${task.priority.toLowerCase()}`}>{task.priority} priority</span><button className="icon-button row-action" title="Move task forward" onClick={() => update(task, statuses[Math.min(i + 1, 2)])} disabled={!canManage || i === 2}><MoreHorizontal size={17} /></button></div><h3>{task.title}</h3><p>{task.description || 'No additional details yet.'}</p><div className="task-project"><span className="mini-project-mark">{task.projectTitle?.slice(0, 1)}</span>{task.projectTitle}</div><div className="task-card-foot"><span>{task.clientName}</span><time>{date(task.dueDate)}</time></div>{canManage && <div className="task-move"><span>MOVE TO</span><select aria-label={`Change status for ${task.title}`} value={task.status} onChange={(e) => update(task, e.target.value)}>{statuses.map((s) => <option key={s}>{s}</option>)}</select></div>}</article>)}{!list.length && <div className="kanban-empty">Nothing here just yet.</div>}</div></section> })}</div><div className="board-note"><span><Check size={15} />{tasks.filter((t) => t.status === 'Completed').length} pieces of work across the finish line.</span><span>{projects.length} projects in view</span></div></>
}

function Invoices({ invoices, open, canManage }) {
  const total = invoices.reduce((sum, i) => sum + i.amount, 0)
  const paid = invoices.reduce((sum, i) => sum + i.amountPaid, 0)
  return <><Heading eyebrow="THE BUSINESS OF GOOD WORK" title="Invoices" description="Clear, current, and accounted for." action={canManage && <AddButton onClick={() => open('invoice')}>New invoice</AddButton>} /><section className="invoice-summary"><div><span>TOTAL INVOICED</span><strong>{money(total)}</strong></div><div><span>COLLECTED</span><strong className="invoice-collected">{money(paid)}</strong></div><div><span>STILL OUTSTANDING</span><strong className="invoice-outstanding">{money(total - paid)}</strong></div><div className="invoice-summary-art"><FileText size={31} /></div></section><section className="surface table-surface"><div className="table-top"><div><h2>All invoices <span className="count-pill">{invoices.length}</span></h2><p>Payment status at a glance.</p></div></div><div className="table-scroll"><table><thead><tr><th>INVOICE</th><th>PROJECT</th><th>CLIENT</th><th>ISSUED</th><th>DUE DATE</th><th>AMOUNT</th><th>STATUS</th>{canManage && <th />}</tr></thead><tbody>{invoices.map((i) => <tr key={i.id}><td><strong className="table-primary">{i.number}</strong></td><td>{i.projectTitle}</td><td>{i.clientName}</td><td>{date(i.createdAt)}</td><td>{date(i.dueDate)}</td><td><strong>{money(i.amount)}</strong>{i.amountPaid > 0 && <span className="table-secondary">{money(i.amountPaid)} paid</span>}</td><td><Badge status={i.status} /></td>{canManage && <td>{i.status !== 'Paid' && <button className="small-link" onClick={() => open('payment', i)}>Record payment</button>}</td>}</tr>)}</tbody></table>{!invoices.length && <Empty title="No invoices yet." detail="Create an invoice when a milestone is ready to bill." />}</div></section></>
}

function Payments({ payments }) {
  const total = payments.reduce((sum, p) => sum + p.amount, 0)
  return <><Heading eyebrow="MONEY IN MOTION" title="Payments" description="A tidy record of the work that’s been paid for." /><section className="payment-total"><span className="payment-total-icon"><ArrowDownLeft size={20} /></span><div><span>TOTAL RECEIVED</span><strong>{money(total)}</strong></div><span className="payment-record-count">{payments.length} recorded payment{payments.length === 1 ? '' : 's'}</span></section><section className="surface table-surface"><div className="table-top"><div><h2>Payment history <span className="count-pill">{payments.length}</span></h2><p>Recorded payments, newest first.</p></div></div><div className="table-scroll"><table><thead><tr><th>DATE</th><th>CLIENT</th><th>PROJECT</th><th>INVOICE</th><th>METHOD</th><th>AMOUNT</th></tr></thead><tbody>{payments.map((p) => <tr key={p.id}><td>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(p.paidAt))}</td><td>{p.clientName}</td><td>{p.projectTitle}</td><td><strong className="table-primary">{p.invoiceNumber}</strong></td><td><span className="payment-method"><ArrowDownLeft size={14} />{p.method}</span></td><td><strong className="payment-amount">{money(p.amount)}</strong></td></tr>)}</tbody></table>{!payments.length && <Empty title="Your first payment is a good feeling." detail="Recorded payments will show up here." />}</div></section></>
}

function History({ history }) {
  return <><Heading eyebrow="A RECORD OF THE LITTLE THINGS" title="Project activity" description="A clear trail of what changed, and when." /><section className="surface history-surface"><div className="section-heading"><div><span className="eyebrow">RECENT UPDATES</span><h2>Across your workspace</h2></div><span className="history-count">{history.length} EVENTS</span></div>{history.length ? <div className="history-list">{history.map((h) => <article className="history-item" key={h.id}><span className="history-icon"><Activity size={16} /></span><div><strong>{h.action}</strong><p>{h.details}</p><span>{h.projectTitle} · {h.userName || 'Studioflow'}</span></div><time>{date(h.createdAt)}</time></article>)}</div> : <Empty title="A quiet start." detail="Project updates will appear here as the work moves along." />}</section></>
}

function Editor({ type, item, clients, projects, invoices, close, submit, busy, error }) {
  const edit = type.startsWith('edit-')
  const titles = { client: 'Add a client', project: 'Start a project', task: 'Add a task', invoice: 'Create an invoice', payment: 'Record a payment', 'edit-client': 'Edit client details', 'edit-project': 'Edit project details' }
  const input = (name, label, value = '', props = {}) => <label>{label}<input name={name} defaultValue={value} required {...props} /></label>
  const select = (name, label, options, value = '') => <label>{label}<select name={name} defaultValue={value} required>{options.map(([id, text]) => <option value={id} key={id}>{text}</option>)}</select></label>
  const projectOptions = projects.map((p) => [p.id, `${p.title} · ${p.clientName}`])
  const openInvoices = invoices.filter((i) => i.status !== 'Paid').map((i) => [i.id, `${i.number} · ${i.projectTitle} (${money(i.amount - i.amountPaid)} due)`])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><span className="eyebrow">STUDIOFLOW WORKSPACE</span><h2 id="modal-title">{titles[type]}</h2></div><button className="icon-button" title="Close" onClick={close}><X size={19} /></button></div><form onSubmit={submit}><div className="modal-fields">
    {(type === 'client' || type === 'edit-client') && <>{input('name', 'Contact name', item?.name, { placeholder: 'e.g. Maya Chen' })}{input('company', 'Company', item?.company, { placeholder: 'e.g. Northstar Studio' })}{input('email', 'Email address', item?.email, { type: 'email', placeholder: 'name@company.com' })}{input('phone', 'Phone number', item?.phone, { type: 'tel' })}<label className="full-field">Notes<textarea name="notes" defaultValue={item?.notes} rows="3" /></label></>}
    {(type === 'project' || type === 'edit-project') && <>{input('title', 'Project name', item?.title, { placeholder: 'e.g. Northstar website' })}{select('clientId', 'Client', clients.map((c) => [c.id, `${c.name}${c.company ? ` · ${c.company}` : ''}`]), String(item?.clientId || ''))}<label className="full-field">Project brief<textarea name="description" defaultValue={item?.description} rows="3" /></label>{input('budget', 'Project budget', item?.budget, { type: 'number', min: 1, step: 1 })}{input('deadline', 'Deadline', item?.deadline, { type: 'date' })}{select('status', 'Project status', ['Planning', 'In Progress', 'Completed', 'On Hold'].map((s) => [s, s]), item?.status || 'Planning')}<label>Deliverables URL<input type="url" name="deliverablesUrl" defaultValue={item?.deliverablesUrl?.startsWith('/uploads/') ? '' : item?.deliverablesUrl} placeholder="https://..." /></label>{item?.deliverablesUrl?.startsWith('/uploads/') && <label className="full-field current-attachment">Current file<a href={item.deliverablesUrl} target="_blank" rel="noreferrer">Open current deliverable</a><input type="hidden" name="existingDeliverableUrl" value={item.deliverablesUrl} /></label>}<label>Upload a file<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.docx,.xlsx" /></label></>}
    {type === 'task' && <>{select('projectId', 'Project', projectOptions)}{input('title', 'Task name', '', { placeholder: 'e.g. Design the homepage' })}<label className="full-field">Details<textarea name="description" rows="3" /></label>{select('priority', 'Priority', ['Low', 'Medium', 'High'].map((s) => [s, s]), 'Medium')}{input('dueDate', 'Due date', '', { type: 'date', required: false })}</>}
    {type === 'invoice' && <>{select('projectId', 'Project', projectOptions)}{input('amount', 'Invoice amount', '', { type: 'number', min: 1, step: '0.01' })}{input('dueDate', 'Due date', '', { type: 'date' })}</>}
    {type === 'payment' && <>{select('invoiceId', 'Invoice', openInvoices, String(item?.id || ''))}{input('amount', 'Payment amount', '', { type: 'number', min: '0.01', step: '0.01' })}{select('method', 'Payment method', ['Bank transfer', 'Credit card', 'PayPal', 'Cash', 'Other'].map((s) => [s, s]), 'Bank transfer')}</>}
  </div>{error && <div className="form-error modal-error" role="alert">{error}</div>}<div className="modal-footer"><button type="button" className="button button-secondary" onClick={close}>Cancel</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Saving...' : edit ? 'Save changes' : type === 'payment' ? 'Record payment' : `Create ${type}`}<ArrowUpRight size={16} /></button></div></form></section></div>
}
