const express = require('express')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { parseBuffer } = require('music-metadata')
const store = require('./store')

const app = express()
const PORT = Number(process.env.PORT) || 3000
const SECRET = process.env.SESSION_SECRET || 'reading-checkin-local-secret-change-me'
const MIN_SECONDS = 600

app.disable('x-powered-by')
app.use(express.json({ limit: '64kb' }))

/* ---------- session (signed cookie, no extra dependency) ---------- */
function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url')
}
function parseCookies(req) {
  const header = req.headers.cookie || ''
  const out = {}
  header.split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  })
  return out
}
function currentUser(req) {
  const cookies = parseCookies(req)
  const raw = cookies.rc_session
  if (!raw) return null
  const [payload, sig] = raw.split('.')
  if (!payload || !sig || sign(payload) !== sig) return null
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!session.exp || session.exp < Date.now()) return null
    return store.findUserById(session.uid) ? { id: session.uid, name: session.name, role: session.role } : null
  } catch {
    return null
  }
}
function setSession(res, user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, name: user.name, role: user.role, exp: Date.now() + 7 * 86400000
  })).toString('base64url')
  res.setHeader('Set-Cookie', `rc_session=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400000}`)
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'rc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
}
function requireAuth(req, res, next) {
  const user = currentUser(req)
  if (!user) return res.status(401).json({ error: 'Please sign in.' })
  req.user = user
  next()
}
function requireTeacher(req, res, next) {
  if (!req.user || req.user.role !== 'teacher') return res.status(403).json({ error: 'Only the teacher can do that.' })
  next()
}

/* ---------- SSE realtime ---------- */
const clients = new Set()
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
  clients.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(ping); clients.delete(res) })
})
function broadcast(payload) {
  const chunk = `data: ${JSON.stringify(payload)}\n\n`
  clients.forEach(res => { try { res.write(chunk) } catch { clients.delete(res) } })
}

/* ---------- upload ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, store.AUDIO_DIR),
    filename: (req, file, cb) => {
      const ext = file.mimetype === 'audio/mp4' || file.mimetype === 'audio/x-m4a' ? 'm4a'
        : file.mimetype.includes('ogg') ? 'ogg'
          : file.mimetype.includes('webm') ? 'webm' : 'bin'
      cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`)
    }
  }),
  limits: { fileSize: 120 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || /\.(webm|ogg|m4a|mp3|mp4|wav)$/i.test(file.originalname)
    cb(ok ? null : new Error('Only audio files are allowed.'), ok)
  }
})

async function actualDuration(file) {
  try {
    const meta = await parseBuffer(fs.readFileSync(file.path), { mimeType: file.mimetype, size: file.size })
    if (Number.isFinite(meta.format.duration) && meta.format.duration > 0) return meta.format.duration
  } catch { /* metadata may be absent in streaming webm */ }
  return null
}

/* ---------- routes ---------- */
app.get('/api/session', (req, res) => {
  const user = currentUser(req)
  res.json({ user, students: user ? store.students() : [] })
})

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {}
  const user = store.authenticate(name, password)
  if (!user) return res.status(401).json({ error: 'Invalid name or password.' })
  setSession(res, user)
  res.json({ user, students: store.students() })
})

app.post('/api/logout', (req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  const ok = store.changePassword(req.user.id, currentPassword, newPassword)
  if (!ok) return res.status(400).json({ error: 'Current password is wrong or new password is too short (min 6).' })
  res.json({ ok: true })
})

app.get('/api/board/:studentId', requireAuth, (req, res) => {
  const student = store.students().find(s => s.id === req.params.studentId)
  if (!student) return res.status(404).json({ error: 'Student not found.' })
  res.json({
    student,
    recordings: store.recordingsFor(student.id),
    progress: store.progressFor(student.id),
    badges: store.BADGES,
    canPostFeedback: req.user.role === 'teacher'
  })
})

app.get('/api/overview', requireAuth, (req, res) => {
  const now = new Date()
  res.json({
    students: store.students().map(s => ({ ...s, progress: store.progressFor(s.id, now) })),
    latest: store.allRecordings().slice(0, 8)
  })
})

app.post('/api/recordings', requireAuth, upload.single('audio'), async (req, res) => {
  const cleanup = () => { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path) }
  if (req.user.role !== 'student') { cleanup(); return res.status(403).json({ error: 'Only students can upload reading audio.' }) }
  if (!req.file) return res.status(400).json({ error: 'Audio file is missing.' })
  if (req.file.size < 40 * 1024) { cleanup(); return res.status(400).json({ error: 'Audio is too short or empty.' }) }

  const declared = Number(req.body.durationSec) || 0
  const parsed = await actualDuration(req.file)
  const seconds = parsed !== null ? parsed : declared
  if (declared < MIN_SECONDS || seconds < MIN_SECONDS) {
    cleanup()
    return res.status(400).json({
      error: 'Reading audio must be at least 10 minutes. Please keep recording until the timer reaches 10:00.',
      seconds: Math.round(seconds), required: MIN_SECONDS
    })
  }

  const rec = store.addRecording({
    studentId: req.user.id,
    title: req.body.title,
    fileName: req.file.filename,
    durationSec: seconds,
    mimeType: req.file.mimetype,
    size: req.file.size
  })
  broadcast({ type: 'recording', studentId: req.user.id, recordingId: rec.id })
  res.status(201).json({ recording: { ...rec, feedbacks: [] }, progress: store.progressFor(req.user.id) })
})

app.post('/api/feedback', requireAuth, requireTeacher, upload.single('audio'), (req, res) => {
  const recording = store.allRecordings().find(r => r.id === req.body.recordingId)
  if (!recording) return res.status(404).json({ error: 'Recording not found.' })
  const text = String(req.body.text || '').trim()
  if (!text && !req.file) return res.status(400).json({ error: 'Please write a comment or record a voice feedback.' })
  let stars = Number(req.body.stars)
  let badges = []
  try { badges = JSON.parse(req.body.badges || '[]') } catch { badges = [] }
  const fb = store.addFeedback({
    recordingId: recording.id,
    teacherId: req.user.id,
    text,
    audioFileName: req.file ? req.file.filename : null,
    stars: Number.isFinite(stars) ? stars : 3,
    badges
  })
  broadcast({ type: 'feedback', studentId: recording.studentId, recordingId: recording.id, feedbackId: fb.id })
  res.status(201).json({ feedback: fb, progress: store.progressFor(recording.studentId) })
})

app.get('/api/audio/:fileName', requireAuth, (req, res) => {
  const name = path.basename(req.params.fileName)
  const file = path.join(store.AUDIO_DIR, name)
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Audio not found.' })
  const stat = fs.statSync(file)
  const mime = name.endsWith('.m4a') ? 'audio/mp4' : name.endsWith('.ogg') ? 'audio/ogg'
    : name.endsWith('.webm') ? 'audio/webm' : name.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream'
  const range = req.headers.range
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range)
    if (match) {
      const start = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
      if (start >= stat.size || end < start) return res.status(416).end()
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime
      })
      return fs.createReadStream(file, { start, end }).pipe(res)
    }
  }
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' })
  fs.createReadStream(file).pipe(res)
})

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.use(express.static(path.join(__dirname, '..', 'public')))
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')))

app.use((err, req, res, next) => {
  console.error(err.message)
  res.status(400).json({ error: err.message || 'Request failed.' })
})

/* ---------- HTTP / HTTPS (HTTPS enabled when cert files exist) ---------- */
function start() {
  const certPath = process.env.TLS_CERT || path.join(__dirname, '..', 'data', 'cert.pem')
  const keyPath = process.env.TLS_KEY || path.join(__dirname, '..', 'data', 'key.pem')
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const https = require('https')
    https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
      .listen(PORT, '0.0.0.0', () => console.log(`Reading Check-in running on https://0.0.0.0:${PORT}`))
  } else {
    app.listen(PORT, '0.0.0.0', () => console.log(`Reading Check-in running on http://0.0.0.0:${PORT}`))
  }
  console.log('Accounts: Teacher / Isabella / Tata (see README for default passwords)')
}
start()
