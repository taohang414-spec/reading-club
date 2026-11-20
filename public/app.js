/* Reading Club — front end */
const app = document.getElementById('app')
const state = {
  user: null,
  students: [],
  activeBoard: null,
  boards: {},
  eventSource: null,
  recorder: null,
  chunks: [],
  recStart: 0,
  recElapsed: 0,
  recTimer: null,
  feedbackRecorder: null,
  feedbackChunks: [],
  feedbackStart: 0,
  feedbackTimer: null,
  feedbackAudio: null,
  stars: 3,
  badges: []
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
const dateLabel = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const avatarClass = (name) => String(name).toLowerCase()

function toast(msg, isError = false) {
  document.querySelectorAll('.toast').forEach(t => t.remove())
  const el = document.createElement('div')
  el.className = `toast${isError ? ' error' : ''}`
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 4000)
}

async function api(url, options = {}) {
  const res = await fetch(url, options)
  let data
  try { data = await res.json() } catch { data = {} }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
  return data
}

/* ---------------- login ---------------- */
function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="brand">
          <div class="brand-mark">📖</div>
          <div><h1>Reading Club</h1><p>Daily English reading, together</p></div>
        </div>
        <h2>Welcome back</h2>
        <p class="sub">Sign in to record your reading or give feedback.</p>
        <form id="loginForm">
          <div class="field"><label for="loginName">Your name</label>
            <input id="loginName" autocomplete="username" placeholder="Isabella / Tata / Teacher" required></div>
          <div class="field"><label for="loginPass">Password</label>
            <input id="loginPass" type="password" autocomplete="current-password" required></div>
          <button class="btn" type="submit" style="width:100%">Sign in</button>
        </form>
        <p class="error" id="loginError"></p>
        <p class="hint">Students: record at least 10 minutes of reading per check-in. Check in 5 days a week.<br>Teacher: leave voice or written feedback and reward positive reading with stars & badges.</p>
      </div>
    </div>`
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const err = document.getElementById('loginError')
    err.textContent = ''
    try {
      const data = await api('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: document.getElementById('loginName').value, password: document.getElementById('loginPass').value })
      })
      state.user = data.user
      state.students = data.students
      state.activeBoard = state.user.role === 'student' ? state.user.id : state.students[0]?.id
      await enterApp()
    } catch (e2) { err.textContent = e2.message }
  })
}

/* ---------------- shell ---------------- */
function sundayNotice(progress) {
  const now = new Date()
  if (now.getDay() !== 0 || now.getHours() < 8) return ''
  const done = progress?.completed
  return `<div class="sunday-banner${done ? ' done' : ''}">
    <div class="icon">${done ? '🎉' : '⏰'}</div>
    <div><strong>${done ? 'Great job — this week is complete!' : 'Sunday reminder: weekly check-in'}</strong>
    <p>${done ? `You read on ${progress.dayCount} days this week. Your 5-day goal is done. Enjoy your week!`
      : `You have checked in ${progress.dayCount} of 5 days this week. ${5 - progress.dayCount} more day${5 - progress.dayCount === 1 ? '' : 's'} to reach your goal.`}</p></div>
  </div>`
}

function renderShell() {
  const isTeacher = state.user.role === 'teacher'
  const tabs = state.students.map(s => {
    const p = state.boards[s.id]?.progress
    const pct = p ? Math.min(100, p.dayCount / p.goal * 100) : 0
    return `<button class="tab${state.activeBoard === s.id ? ' active' : ''}" data-board="${s.id}">
      <div class="tab-name">${avatarClass(s.name) === 'isabella' ? '👧' : '🧒'} ${esc(s.name)}${state.user.id === s.id ? ' <span class="pill">YOU</span>' : ''}</div>
      <div class="tab-sub">${p ? `${p.dayCount} / ${p.goal} days this week` : 'Reading board'}</div>
      <div class="mini-progress"><i style="width:${pct}%"></i></div>
    </button>`
  }).join('')

  app.innerHTML = `<div class="shell">
    <div class="topbar">
      <div class="brand"><div class="brand-mark">📖</div><div><h1>Reading Club</h1><p>Daily English reading</p></div></div>
      <div class="user-chip">
        <div class="avatar ${avatarClass(state.user.name)}">${esc(state.user.name[0])}</div>
        <div class="user-meta"><strong>${esc(state.user.name)}</strong><span>${isTeacher ? 'Teacher' : 'Student'}</span></div>
        <button class="btn btn-ghost btn-small" id="settingsBtn">Settings</button>
        <button class="btn btn-ghost btn-small" id="logoutBtn">Sign out</button>
      </div>
    </div>
    <div id="noticeArea"></div>
    <div class="tabs">${tabs}</div>
    <div class="grid" id="boardArea"></div>
  </div>`

  document.getElementById('logoutBtn').onclick = async () => {
    await api('/api/logout', { method: 'POST' })
    stopEvents(); state.user = null; renderLogin()
  }
  const settingsBtn = document.getElementById('settingsBtn')
  settingsBtn.onclick = openSettings
  document.querySelectorAll('[data-board]').forEach(btn => {
    btn.onclick = async () => { state.activeBoard = btn.dataset.board; renderShell(); await loadBoard(btn.dataset.board) }
  })
}

function openSettings() {
  const wrap = document.createElement('div')
  wrap.className = 'card'
  wrap.style.cssText = 'position:fixed;inset:10% 30%;z-index:40;max-height:80vh;overflow:auto'
  wrap.innerHTML = `<h3>Account settings</h3><p class="desc">Change your password.</p>
    <form id="passForm">
      <div class="field"><label>Current password</label><input id="curPass" type="password" required></div>
      <div class="field"><label>New password (min 6 characters)</label><input id="newPass" type="password" minlength="6" required></div>
      <p class="error" id="passErr"></p>
      <div style="display:flex;gap:8px"><button class="btn" type="submit">Save</button>
      <button type="button" class="btn btn-ghost" id="closeSettings">Close</button></div>
    </form>`
  document.body.appendChild(wrap)
  document.getElementById('closeSettings').onclick = () => wrap.remove()
  document.getElementById('passForm').onsubmit = async e => {
    e.preventDefault()
    try {
      await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: document.getElementById('curPass').value, newPassword: document.getElementById('newPass').value }) })
      toast('Password updated'); wrap.remove()
    } catch (err) { document.getElementById('passErr').textContent = err.message }
  }
}

/* ---------------- board ---------------- */
function renderBoard(studentId) {
  const board = state.boards[studentId]
  if (!board) return
  const p = board.progress
  const own = state.user.role === 'student' && state.user.id === studentId
  const isTeacher = state.user.role === 'teacher'

  const noticeArea = document.getElementById('noticeArea')
  if (noticeArea) noticeArea.innerHTML = own ? sundayNotice(p) : ''

  const progressCard = `<div class="card">
    <h3>📅 This week's check-in</h3>
    <p class="desc">Read for at least 10 minutes a day, 5 days a week.</p>
    <div class="progress-head"><div class="big">${p.dayCount}<span> / ${p.goal} days</span></div>
      <span class="pill${p.completed ? ' yellow' : ''}">${p.completed ? 'Goal reached' : 'In progress'}</span></div>
    <div class="week-dots">${p.weekDays.map(d => `<div class="dot${d.done ? ' done' : ''}" title="${d.key}">${d.label}</div>`).join('')}</div>
    <div class="stat-row">
      <div class="stat"><b>${p.checkins}</b><span>Recordings</span></div>
      <div class="stat"><b>${p.minutes}</b><span>Minutes</span></div>
      <div class="stat"><b>${p.stars}</b><span>Stars earned</span></div>
    </div>
    ${Object.keys(p.badges).length ? `<div class="badge-row">${Object.entries(p.badges).map(([id, n]) => {
      const b = board.badges.find(x => x.id === id)
      return `<span class="badge">${b?.icon || '⭐'} ${esc(b?.label || id)} × ${n}</span>`
    }).join('')}</div>` : ''}
  </div>`

  const recorderCard = own ? `<div class="card">
    <h3>🎙️ Record your reading</h3>
    <p class="desc">Read aloud from your book. Upload becomes available at 10:00.</p>
    <div class="recorder">
      <div class="timer" id="recTimer">00:00</div>
      <div class="timer-label"><span class="rec-dot" id="recDot" style="display:none"></span><span id="recStatus">Ready when you are</span></div>
      <div class="wave${state.recorder?.state === 'recording' ? ' live' : ''}" id="wave">${Array.from({ length: 19 }, () => '<i></i>').join('')}</div>
      <div class="notice" id="recNotice">Minimum length: 10 minutes</div>
      <div class="rec-actions">
        <button class="btn" id="startRec">Start recording</button>
        <button class="btn btn-yellow hidden" id="stopRec">Stop</button>
        <button class="btn btn-ghost hidden" id="uploadRec">Upload reading</button>
        <button class="btn btn-danger hidden" id="discardRec">Discard</button>
      </div>
      <div class="field" style="margin-top:14px;text-align:left"><label for="recTitle">Reading title (optional)</label>
        <input id="recTitle" placeholder="e.g. Chapter 3 — The Garden"></div>
    </div>
  </div>` : ''

  const records = board.recordings.map(r => {
    const fbs = r.feedbacks.map(f => {
      const badgeNames = f.badges.map(id => {
        const b = board.badges.find(x => x.id === id)
        return b ? `<span>${b.icon} ${esc(b.label)}</span>` : ''
      }).join('')
      return `<div class="feedback">
        <div class="who">Teacher feedback · ${dateLabel(f.createdAt)} <span class="stars">${'★'.repeat(f.stars)}${'☆'.repeat(5 - f.stars)}</span></div>
        ${f.text ? `<p>${esc(f.text)}</p>` : ''}
        ${f.audioFileName ? `<audio controls preload="none" src="/api/audio/${encodeURIComponent(f.audioFileName)}"></audio>` : ''}
        ${badgeNames ? `<div class="badges">${badgeNames}</div>` : ''}
      </div>`
    }).join('')
    const feedbackForm = isTeacher ? `<div class="feedback-form" data-rec="${r.id}">
      <div class="field"><label>Your written feedback</label><textarea rows="2" placeholder="Great expression and clear pronunciation..."></textarea></div>
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div><label style="font-size:12px;font-weight:800;color:var(--blue-800)">Stars</label>
          <div class="star-picker">${[1,2,3,4,5].map(n => `<button type="button" data-star="${n}" class="${n <= 3 ? 'on' : ''}">★</button>`).join('')}</div></div>
        <div style="flex:1"><label style="font-size:12px;font-weight:800;color:var(--blue-800)">Rewards</label>
          <div class="badge-picker">${board.badges.map(b => `<button type="button" data-badge="${b.id}">${b.icon} ${esc(b.label)}</button>`).join('')}</div></div>
      </div>
      <div class="rec-actions" style="justify-content:flex-start;margin-top:12px">
        <button class="btn btn-small feedback-voice">🎙️ Record voice feedback</button>
        <button class="btn btn-yellow btn-small send-feedback">Post feedback</button>
      </div>
      <div class="feedback-voice-area"></div>
    </div>` : ''
    return `<div class="record">
      <div class="record-head"><div><div class="record-title">📖 ${esc(r.title)}</div>
        <div class="record-meta">${dateLabel(r.createdAt)} · ${fmtTime(r.durationSec)} · ${state.students.find(s => s.id === r.studentId)?.name || ''}</div></div>
        <span class="pill">${fmtTime(r.durationSec)}</span></div>
      <audio controls preload="none" src="/api/audio/${encodeURIComponent(r.fileName)}"></audio>
      <div class="feedbacks">${fbs || '<p class="desc" style="margin:0">No teacher feedback yet.</p>'}${feedbackForm}</div>
    </div>`
  }).join('')

  document.getElementById('boardArea').innerHTML = `
    <div>
      ${recorderCard}
      <div class="card"><h3>📚 Reading records</h3><p class="desc">All reading audio and teacher feedback.</p>
        ${board.recordings.length ? records : '<div class="empty">No reading records yet. Start your first recording!</div>'}
      </div>
    </div>
    <div>${progressCard}</div>`

  if (own) bindRecorder()
  if (isTeacher) bindFeedbackForms()
}

async function loadBoard(studentId) {
  try {
    const board = await api(`/api/board/${studentId}`)
    state.boards[studentId] = board
    renderBoard(studentId)
  } catch (e) { toast(e.message, true) }
}

/* ---------------- student recorder ---------------- */
function bindRecorder() {
  const startBtn = document.getElementById('startRec')
  if (!startBtn) return
  const stopBtn = document.getElementById('stopRec')
  const uploadBtn = document.getElementById('uploadRec')
  const discardBtn = document.getElementById('discardRec')
  const timerEl = document.getElementById('recTimer')
  const statusEl = document.getElementById('recStatus')
  const noticeEl = document.getElementById('recNotice')
  const dot = document.getElementById('recDot')
  const wave = document.getElementById('wave')

  const paint = () => {
    const sec = state.recElapsed + (state.recorder?.state === 'recording' ? (Date.now() - state.recStart) / 1000 : 0)
    timerEl.textContent = fmtTime(sec)
    const ready = sec >= 600
    noticeEl.textContent = ready ? '✅ Ready to upload — 10 minutes reached' : `Minimum length: 10 minutes (${fmtTime(600 - sec)} to go)`
    noticeEl.classList.toggle('ok', ready)
    uploadBtn.classList.toggle('hidden', !ready)
  }
  clearInterval(state.recTimer)
  state.recTimer = setInterval(paint, 500)
  paint()

  startBtn.onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('Recording is not supported in this browser.', true); return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
      state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      state.chunks = []
      state.recElapsed = 0
      state.recorder.ondataavailable = e => { if (e.data.size) state.chunks.push(e.data) }
      state.recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        state.recElapsed += (Date.now() - state.recStart) / 1000
        state.recorder = null
        dot.style.display = 'none'; wave.classList.remove('live')
        stopBtn.classList.add('hidden'); discardBtn.classList.add('hidden')
        startBtn.classList.remove('hidden')
        startBtn.textContent = 'Record again'
        paint()
      }
      state.recorder.start(1000)
      state.recStart = Date.now()
      dot.style.display = 'inline-block'; wave.classList.add('live')
      statusEl.textContent = 'Recording in progress'
      startBtn.classList.add('hidden'); stopBtn.classList.remove('hidden'); discardBtn.classList.remove('hidden')
      paint()
    } catch (e) { toast('Microphone permission is needed to record.', true) }
  }
  stopBtn.onclick = () => { if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop() }
  discardBtn.onclick = () => {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop()
    state.chunks = []; state.recElapsed = 0; timerEl.textContent = '00:00'
    uploadBtn.classList.add('hidden'); statusEl.textContent = 'Ready when you are'
    startBtn.classList.remove('hidden'); startBtn.textContent = 'Start recording'
  }
  uploadBtn.onclick = async () => {
    const durationSec = state.recElapsed
    if (durationSec < 600) { toast('Recording must be at least 10 minutes.', true); return }
    const blob = new Blob(state.chunks, { type: state.chunks[0]?.type || 'audio/webm' })
    const fd = new FormData()
    fd.append('audio', blob, 'reading.webm')
    fd.append('durationSec', String(durationSec))
    fd.append('title', document.getElementById('recTitle').value || `${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} reading`)
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading...'
    try {
      await api('/api/recordings', { method: 'POST', body: fd })
      toast('Reading uploaded! Well done 📚')
      state.chunks = []; state.recElapsed = 0
      await loadBoard(state.user.id)
    } catch (e) { toast(e.message, true); uploadBtn.disabled = false; uploadBtn.textContent = 'Upload reading' }
  }
}

/* ---------------- teacher feedback ---------------- */
function bindFeedbackForms() {
  document.querySelectorAll('.feedback-form').forEach(form => {
    const recId = form.dataset.rec
    let stars = 3
    let badges = []
    const textarea = form.querySelector('textarea')
    const starBtns = form.querySelectorAll('[data-star]')
    const badgeBtns = form.querySelectorAll('[data-badge]')
    starBtns.forEach(b => b.onclick = () => {
      stars = Number(b.dataset.star)
      starBtns.forEach(x => x.classList.toggle('on', Number(x.dataset.star) <= stars))
    })
    badgeBtns.forEach(b => b.onclick = () => {
      const id = b.dataset.badge
      if (badges.includes(id)) badges = badges.filter(x => x !== id)
      else badges.push(id)
      b.classList.toggle('on', badges.includes(id))
    })
    const voiceArea = form.querySelector('.feedback-voice-area')
    const voiceBtn = form.querySelector('.feedback-voice')
    let recorder = null, chunks = [], start = 0, elapsed = 0, timer = null, voiceBlob = null

    const paintVoice = () => {
      const sec = elapsed + (recorder?.state === 'recording' ? (Date.now() - start) / 1000 : 0)
      const label = voiceArea.querySelector('.vtime')
      if (label) label.textContent = fmtTime(sec)
    }
    voiceBtn.onclick = async () => {
      if (recorder && recorder.state === 'recording') {
        recorder.stop(); clearInterval(timer); return
      }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('Voice recording is not supported here.', true); return }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
        chunks = []; elapsed = 0
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
        recorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop())
          elapsed += (Date.now() - start) / 1000
          recorder = null
          voiceBtn.textContent = '🎙️ Record voice feedback'
          if (chunks.length) {
            const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
            voiceBlob = blob
            voiceArea.innerHTML = `<div style="margin-top:8px;font-size:12px">Voice feedback ( <span class="vtime">${fmtTime(elapsed)}</span> ) <audio controls src="${URL.createObjectURL(blob)}"></audio></div>`
          }
        }
        recorder.start(500); start = Date.now()
        voiceBtn.textContent = '⏹ Stop voice recording'
        voiceArea.innerHTML = '<div style="margin-top:8px;font-size:12px">Recording... <span class="vtime">00:00</span></div>'
        timer = setInterval(paintVoice, 500)
      } catch { toast('Microphone permission is needed.', true) }
    }

    form.querySelector('.send-feedback').onclick = async (e) => {
      e.preventDefault()
      const fd = new FormData()
      fd.append('recordingId', recId)
      fd.append('text', textarea.value.trim())
      fd.append('stars', String(stars))
      fd.append('badges', JSON.stringify(badges))
      if (voiceBlob) fd.append('audio', voiceBlob, 'feedback.webm')
      const btn = e.currentTarget
      btn.disabled = true; btn.textContent = 'Posting...'
      try {
        await api('/api/feedback', { method: 'POST', body: fd })
        voiceBlob = null
        toast('Feedback posted')
        await loadBoard(state.activeBoard)
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Post feedback' }
    }
  })
}

/* ---------------- realtime ---------------- */
function startEvents() {
  stopEvents()
  const es = new EventSource('/api/events')
  es.onmessage = async (e) => {
    let payload
    try { payload = JSON.parse(e.data) } catch { return }
    if (payload.type === 'connected') return
    if (payload.type === 'recording' || payload.type === 'feedback') {
      await loadBoard(state.activeBoard)
      if (payload.type === 'feedback' && payload.studentId !== state.user.id) toast('New teacher feedback received ✨')
    }
  }
  state.eventSource = es
}
function stopEvents() { if (state.eventSource) { state.eventSource.close(); state.eventSource = null } }

async function enterApp() {
  renderShell()
  await loadBoard(state.activeBoard)
  startEvents()
}

async function boot() {
  try {
    const data = await api('/api/session')
    if (data.user) {
      state.user = data.user; state.students = data.students
      state.activeBoard = state.user.role === 'student' ? state.user.id : state.students[0]?.id
      await enterApp()
      return
    }
  } catch { /* not signed in */ }
  renderLogin()
}
boot()
