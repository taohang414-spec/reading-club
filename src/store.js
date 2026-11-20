const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')
const AUDIO_DIR = path.join(DATA_DIR, 'audio')

const BADGES = [
  { id: 'star-reader', label: 'Star Reader', icon: '🌟' },
  { id: 'fluent', label: 'Fluent Reader', icon: '🚀' },
  { id: 'great-pronunciation', label: 'Great Pronunciation', icon: '🎯' },
  { id: 'brave-voice', label: 'Brave Voice', icon: '💛' },
  { id: 'word-master', label: 'Word Master', icon: '📚' },
  { id: 'super-focus', label: 'Super Focus', icon: '⭐' }
]

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  const candidate = crypto.scryptSync(String(password), salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)
}

function emptyDb() {
  return { users: [], recordings: [], feedbacks: [], meta: { createdAt: new Date().toISOString() } }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(AUDIO_DIR, { recursive: true })
  if (!fs.existsSync(DB_FILE)) {
    const db = emptyDb()
    const accounts = [
      { id: 'u_teacher', name: 'Teacher', role: 'teacher', password: process.env.TEACHER_PASSWORD || 'teacher123' },
      { id: 'u_isabella', name: 'Isabella', role: 'student', password: process.env.ISABELLA_PASSWORD || 'isabella123' },
      { id: 'u_tata', name: 'Tata', role: 'student', password: process.env.TATA_PASSWORD || 'tata123' }
    ]
    db.users = accounts.map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      passwordHash: hashPassword(a.password),
      createdAt: new Date().toISOString()
    }))
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
    return db
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  } catch (err) {
    throw new Error(`Cannot read data file: ${err.message}`)
  }
}

let db = load()

function save() {
  const tmp = `${DB_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
  fs.renameSync(tmp, DB_FILE)
}

function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role }
}

function findUserById(id) {
  return db.users.find(u => u.id === id) || null
}

function authenticate(name, password) {
  const user = db.users.find(u => u.name.toLowerCase() === String(name || '').trim().toLowerCase())
  if (!user || !verifyPassword(password, user.passwordHash)) return null
  return publicUser(user)
}

function changePassword(id, currentPassword, newPassword) {
  const user = findUserById(id)
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) return false
  if (!newPassword || String(newPassword).length < 6) return false
  user.passwordHash = hashPassword(newPassword)
  save()
  return true
}

function students() {
  return db.users.filter(u => u.role === 'student').map(publicUser)
}

function addRecording({ studentId, title, fileName, durationSec, mimeType, size }) {
  const rec = {
    id: `r_${crypto.randomBytes(8).toString('hex')}`,
    studentId,
    title: String(title || 'Reading practice').trim().slice(0, 120),
    fileName,
    durationSec: Math.round(durationSec),
    mimeType,
    size,
    createdAt: new Date().toISOString()
  }
  db.recordings.push(rec)
  save()
  return rec
}

function addFeedback({ recordingId, teacherId, text, audioFileName, stars, badges }) {
  const fb = {
    id: `f_${crypto.randomBytes(8).toString('hex')}`,
    recordingId,
    teacherId,
    text: String(text || '').trim().slice(0, 2000),
    audioFileName: audioFileName || null,
    stars: Math.min(5, Math.max(1, Number(stars) || 3)),
    badges: Array.isArray(badges) ? badges.filter(id => BADGES.some(b => b.id === id)).slice(0, 6) : [],
    createdAt: new Date().toISOString()
  }
  db.feedbacks.push(fb)
  save()
  return fb
}

function weekKey(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 4 - (d.getDay() || 7))
  const yearStart = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

function dayKey(date = new Date()) {
  const d = new Date(date)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function recordingsFor(studentId) {
  return db.recordings
    .filter(r => r.studentId === studentId)
    .map(r => ({ ...r, feedbacks: db.feedbacks.filter(f => f.recordingId === r.id) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

function allRecordings() {
  return db.recordings
    .map(r => ({ ...r, feedbacks: db.feedbacks.filter(f => f.recordingId === r.id) }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

function progressFor(studentId, referenceDate = new Date()) {
  const wk = weekKey(referenceDate)
  const days = new Set()
  let checkins = 0
  let minutes = 0
  for (const r of db.recordings) {
    if (r.studentId !== studentId) continue
    if (weekKey(new Date(r.createdAt)) !== wk) continue
    days.add(dayKey(new Date(r.createdAt)))
    checkins += 1
    minutes += r.durationSec / 60
  }
  let stars = 0
  const badgeCounts = {}
  for (const f of db.feedbacks) {
    const rec = db.recordings.find(r => r.id === f.recordingId)
    if (!rec || rec.studentId !== studentId) continue
    if (weekKey(new Date(f.createdAt)) !== wk) continue
    stars += f.stars
    f.badges.forEach(b => { badgeCounts[b] = (badgeCounts[b] || 0) + 1 })
  }
  const monday = new Date(referenceDate)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    const key = dayKey(d)
    return { key, label: ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i], done: days.has(key) }
  })

  return {
    weekKey: wk,
    checkedDays: [...days].sort(),
    weekDays,
    dayCount: days.size,
    goal: 5,
    completed: days.size >= 5,
    checkins,
    minutes: Math.round(minutes),
    stars,
    badges: badgeCounts
  }
}

module.exports = {
  DATA_DIR, AUDIO_DIR, BADGES,
  hashPassword, verifyPassword, load, save,
  publicUser, findUserById, authenticate, changePassword,
  students, addRecording, addFeedback,
  weekKey, dayKey, recordingsFor, allRecordings, progressFor
}
