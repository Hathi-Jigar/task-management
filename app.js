/* ================================================================
   Quest Log — Gamified Task Management
   All data lives in GitHub Issues on this repo.
   ================================================================ */

const CONFIG = {
  owner: 'Hathi-Jigar',
  repo: 'task-management',
  defaultTime: '18:30',
  metaMarkerStart: '<!-- quest-meta',
  metaMarkerEnd: '-->',
  stateLabel: 'quest',
  recurringPrefix: 'recurring:',
  tz: 'Asia/Kolkata'
};

const BADGES = [
  { id: 'first_quest',    icon: '🎯', name: 'First Quest',      desc: 'Add your first quest' },
  { id: 'first_victory',  icon: '⚔️', name: 'First Victory',    desc: 'Close your first quest' },
  { id: 'streak_3',       icon: '🔥', name: 'On a Roll',        desc: '3-day streak' },
  { id: 'streak_7',       icon: '🔥', name: 'Week Warrior',     desc: '7-day streak' },
  { id: 'streak_30',      icon: '💎', name: 'Disciplined',      desc: '30-day streak' },
  { id: 'streak_100',     icon: '👑', name: 'Centennial',       desc: '100-day streak' },
  { id: 'early_bird',     icon: '🐦', name: 'Early Bird',       desc: 'Close 5 quests before deadline' },
  { id: 'dawn_warrior',   icon: '🌅', name: 'Dawn Warrior',     desc: 'Close a quest before 9 AM' },
  { id: 'night_owl',      icon: '🦉', name: 'Night Owl',        desc: 'Close a quest after 11 PM' },
  { id: 'speedrunner',    icon: '⚡', name: 'Speedrunner',      desc: 'Close a quest within 1 hour' },
  { id: 'comeback_kid',   icon: '🛡️', name: 'Comeback Kid',     desc: 'Close 3 overdue quests' },
  { id: 'prolific',       icon: '📚', name: 'Prolific',         desc: 'Add 50 quests' },
  { id: 'organizer',      icon: '🎨', name: 'Organizer',        desc: 'Use 5+ different tags' },
  { id: 'level_5',        icon: '🏅', name: 'Novice',           desc: 'Reach Level 5' },
  { id: 'level_10',       icon: '🎖️', name: 'Adept',            desc: 'Reach Level 10' },
  { id: 'level_25',       icon: '🏆', name: 'Expert',           desc: 'Reach Level 25' },
  { id: 'level_50',       icon: '⚜️', name: 'Master',           desc: 'Reach Level 50' },
  { id: 'centurion',      icon: '🎖️', name: 'Centurion',        desc: 'Close 100 quests' },
  { id: 'zero_overdue',   icon: '🧘', name: 'Zen Mind',         desc: 'Clear all overdue quests' },
  { id: 'planner',        icon: '📝', name: 'Planner',          desc: 'Add 5 quests in a single day' }
];

/* ========== STATE ========== */
const S = {
  token: localStorage.getItem('ghToken') || null,
  name: localStorage.getItem('questName') || '',
  tasks: [],
  labels: [],
  stats: null,
  activeTab: 'mine',
  pendingCloseTask: null,
  pendingReopenTask: null,
  activeTagFilter: null,
  editingTaskId: null,
  selectedTags: new Set(),
  soundOn: localStorage.getItem('soundOn') !== 'false',
  deferredInstall: null,
  prevLevel: 1,
  prevBadges: new Set(),
  lastRefreshAt: 0,
  autoRefreshTimer: null,
  // Meetings are served from a committed meetings.json file — no OAuth.
  // 'loading' before first fetch, 'ready' once we have data, 'error' on failure.
  gcalStatus: 'loading',
  gcalMeetings: [],
  gcalGeneratedAt: null,
  gcalTimer: null,
  gcalCountdownTimer: null,
  gcalRange: localStorage.getItem('gcalRange') || 'upcoming',
  expandedMeetingIds: new Set()
};

const AUTO_REFRESH_INTERVAL_MS = 90_000; // background poll while visible
const STALE_THRESHOLD_MS = 30_000;        // auto-refresh on focus if older than this

/* ========== DOM ========== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ========== GITHUB API ========== */
async function gh(path, method = 'GET', body = null) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `token ${S.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.text();
    console.error('GH API error', res.status, err);
    throw new Error(`GitHub API ${res.status}: ${err.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function verifyToken(token) {
  const res = await fetch(`https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  return res.ok;
}

async function fetchAllIssues() {
  const issues = [];
  let page = 1;
  while (true) {
    const batch = await gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/issues?state=all&per_page=100&page=${page}&labels=${CONFIG.stateLabel}`);
    if (!batch.length) break;
    issues.push(...batch.filter(i => !i.pull_request));
    if (batch.length < 100) break;
    page++;
  }
  return issues;
}

async function fetchLabels() {
  const labels = [];
  let page = 1;
  while (true) {
    const batch = await gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/labels?per_page=100&page=${page}`);
    if (!batch.length) break;
    labels.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return labels;
}

async function ensureBaseLabels() {
  const existing = new Set(S.labels.map(l => l.name));
  const needed = [
    { name: CONFIG.stateLabel, color: 'a78bfa', description: 'Marks an issue as a Quest Log task' },
    { name: 'recurring:daily', color: 'ff9e00', description: 'Recurring daily' },
    { name: 'recurring:weekly', color: 'ff9e00', description: 'Recurring weekly' },
    { name: 'recurring:monthly', color: 'ff9e00', description: 'Recurring monthly' }
  ];
  for (const l of needed) {
    if (!existing.has(l.name)) {
      try {
        const created = await gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/labels`, 'POST', l);
        S.labels.push(created);
      } catch (e) { console.warn('Could not create label', l.name, e); }
    }
  }
}

/* ========== TASK SERIALIZATION ========== */
function serializeTask({ deadline, recurring, assignee, notes, createdAt }) {
  const assigneeLine = assignee ? `\nassignee: ${assignee}` : '';
  const meta = `${CONFIG.metaMarkerStart}\nversion: 1\ndeadline: ${deadline}\nrecurring: ${recurring || 'none'}${assigneeLine}\ncreatedAt: ${createdAt}\n${CONFIG.metaMarkerEnd}`;
  return `${meta}\n\n${notes || ''}`.trim();
}

function parseTask(issue) {
  const body = issue.body || '';
  const metaMatch = body.match(/<!--\s*quest-meta([\s\S]*?)-->/);
  const meta = {};
  if (metaMatch) {
    metaMatch[1].split('\n').forEach(line => {
      // assignee names can contain spaces/punctuation, so capture everything after "key:"
      const m = line.match(/^\s*([a-zA-Z]+):\s*(.+?)\s*$/);
      if (m) meta[m[1]] = m[2];
    });
  }
  const notes = body.replace(/<!--\s*quest-meta[\s\S]*?-->\s*/, '').trim();
  const tagLabels = issue.labels
    .filter(l => l.name !== CONFIG.stateLabel && !l.name.startsWith(CONFIG.recurringPrefix))
    .map(l => l.name);
  const recurringLabel = issue.labels.find(l => l.name.startsWith(CONFIG.recurringPrefix));
  const recurring = meta.recurring || (recurringLabel ? recurringLabel.name.slice(CONFIG.recurringPrefix.length) : 'none');

  return {
    id: issue.number,
    title: issue.title,
    deadline: meta.deadline || null,
    recurring,
    assignee: meta.assignee || '',
    notes,
    tags: tagLabels,
    state: issue.state,
    createdAt: meta.createdAt || issue.created_at,
    closedAt: issue.closed_at,
    issue
  };
}

/* ========== TASK CRUD ========== */
async function createTask(data) {
  const labels = [CONFIG.stateLabel, ...data.tags];
  if (data.recurring && data.recurring !== 'none') labels.push(`${CONFIG.recurringPrefix}${data.recurring}`);
  const body = serializeTask({
    deadline: data.deadline,
    recurring: data.recurring,
    assignee: data.assignee,
    notes: data.notes,
    createdAt: new Date().toISOString()
  });
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/issues`, 'POST', {
    title: data.title, body, labels
  });
}

async function updateTask(issueNumber, data) {
  const labels = [CONFIG.stateLabel, ...data.tags];
  if (data.recurring && data.recurring !== 'none') labels.push(`${CONFIG.recurringPrefix}${data.recurring}`);
  const existingTask = S.tasks.find(t => t.id === issueNumber);
  const createdAt = existingTask?.createdAt || new Date().toISOString();
  const body = serializeTask({
    deadline: data.deadline,
    recurring: data.recurring,
    assignee: data.assignee,
    notes: data.notes,
    createdAt
  });
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, 'PATCH', {
    title: data.title, body, labels, state: 'open'
  });
}

async function closeTaskApi(issueNumber) {
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, 'PATCH', { state: 'closed' });
}

async function reopenTaskApi(issueNumber) {
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, 'PATCH', { state: 'open' });
}

async function deleteTaskApi(issueNumber) {
  // GitHub REST can't truly delete issues via standard token. Close with label 'deleted' and hide from UI.
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${issueNumber}`, 'PATCH', {
    state: 'closed',
    labels: ['deleted']
  });
}

/* ========== LABEL CRUD ========== */
async function createLabel(name, color) {
  const hex = (color || '#a78bfa').replace('#', '');
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/labels`, 'POST', { name, color: hex });
}

async function updateLabel(oldName, newName, color) {
  const hex = (color || '#a78bfa').replace('#', '');
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/labels/${encodeURIComponent(oldName)}`, 'PATCH', {
    new_name: newName, color: hex
  });
}

async function deleteLabelApi(name) {
  return gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/labels/${encodeURIComponent(name)}`, 'DELETE');
}

/* ========== GAMIFICATION ========== */
function levelFromXP(xp) {
  // cumulative XP for level N = 100 * N * (N-1) / 2
  // invert: N = floor((1 + sqrt(1 + xp/12.5))/2)
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + xp / 12.5)) / 2));
}
function xpForLevel(n) { return 100 * n * (n - 1) / 2; }
function xpForNextLevel(xp) {
  const lvl = levelFromXP(xp);
  return xpForLevel(lvl + 1);
}

function computeCloseXP(task) {
  if (!task.closedAt || !task.deadline) return 10;
  const created = new Date(task.createdAt).getTime();
  const closed = new Date(task.closedAt).getTime();
  const deadline = new Date(task.deadline).getTime();
  let xp = 10;
  if (closed <= deadline) {
    const hoursEarly = (deadline - closed) / 3600000;
    if (hoursEarly >= 24) xp += 10;
    else if (hoursEarly >= 1) xp += 5;
    else xp += 2;
  } else {
    const daysLate = (closed - deadline) / 86400000;
    xp -= Math.min(5, Math.floor(daysLate) + 1);
  }
  if (closed - created < 3600000) xp += 5;
  return Math.max(1, xp);
}

function computeStats(tasks) {
  const now = Date.now();
  // Delegated quests are tracking-only — they don't feed XP, HP, streaks, or badges.
  // The user didn't do the work, so their personal stats shouldn't reflect it.
  const active = tasks.filter(t => !(t.issue?.labels || []).some(l => l.name === 'deleted') && !t.assignee);
  const closed = active.filter(t => t.state === 'closed');
  const open = active.filter(t => t.state === 'open');
  const overdue = open.filter(t => t.deadline && new Date(t.deadline).getTime() < now);

  // XP: +5 per task created + close XP per closed task
  let xp = active.length * 5;
  for (const t of closed) xp += computeCloseXP(t);

  const level = levelFromXP(xp);
  const xpIntoLevel = xp - xpForLevel(level);
  const xpToNext = xpForLevel(level + 1) - xpForLevel(level);

  // HP
  const drain = overdue.reduce((sum, t) => {
    const days = (now - new Date(t.deadline).getTime()) / 86400000;
    return sum + Math.min(30, 2 * days);
  }, 0);
  const hp = Math.max(0, Math.round(100 - drain));

  // Streak: consecutive days (back from today) with >= 1 close
  const byDay = new Set(closed.map(t => new Date(t.closedAt).toDateString()));
  let streak = 0;
  let d = new Date();
  while (byDay.has(d.toDateString())) {
    streak++;
    d.setDate(d.getDate() - 1);
    if (streak > 10000) break;
  }

  // Badges
  const earned = new Set();
  const earlyCloses = closed.filter(t => t.deadline && new Date(t.closedAt) <= new Date(t.deadline)).length;
  const lateCloses = closed.filter(t => t.deadline && new Date(t.closedAt) > new Date(t.deadline)).length;
  const uniqueTags = new Set(active.flatMap(t => t.tags));
  const addsPerDay = {};
  active.forEach(t => {
    const day = new Date(t.createdAt).toDateString();
    addsPerDay[day] = (addsPerDay[day] || 0) + 1;
  });
  const maxAddsOneDay = Math.max(0, ...Object.values(addsPerDay));

  if (active.length >= 1) earned.add('first_quest');
  if (closed.length >= 1) earned.add('first_victory');
  if (streak >= 3) earned.add('streak_3');
  if (streak >= 7) earned.add('streak_7');
  if (streak >= 30) earned.add('streak_30');
  if (streak >= 100) earned.add('streak_100');
  if (earlyCloses >= 5) earned.add('early_bird');
  if (lateCloses >= 3) earned.add('comeback_kid');
  if (active.length >= 50) earned.add('prolific');
  if (uniqueTags.size >= 5) earned.add('organizer');
  if (level >= 5) earned.add('level_5');
  if (level >= 10) earned.add('level_10');
  if (level >= 25) earned.add('level_25');
  if (level >= 50) earned.add('level_50');
  if (closed.length >= 100) earned.add('centurion');
  if (open.length > 0 && overdue.length === 0 && closed.length >= 3) earned.add('zero_overdue');
  if (maxAddsOneDay >= 5) earned.add('planner');
  for (const t of closed) {
    if (!t.closedAt) continue;
    const h = new Date(t.closedAt).getHours();
    if (h < 9) earned.add('dawn_warrior');
    if (h >= 23) earned.add('night_owl');
    if (t.createdAt && (new Date(t.closedAt) - new Date(t.createdAt)) < 3600000) earned.add('speedrunner');
  }

  return {
    xp, level, xpIntoLevel, xpToNext,
    hp, streak,
    openCount: open.length,
    closedCount: closed.length,
    overdueCount: overdue.length,
    badges: earned
  };
}

/* ========== RECURRING ========== */
function nextRecurrenceDate(deadline, type) {
  const d = new Date(deadline);
  if (type === 'daily') d.setDate(d.getDate() + 1);
  else if (type === 'weekly') d.setDate(d.getDate() + 7);
  else if (type === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function handleRecurring(task) {
  if (!task.recurring || task.recurring === 'none') return null;
  const nextDeadline = nextRecurrenceDate(task.deadline, task.recurring);
  return createTask({
    title: task.title,
    deadline: nextDeadline,
    recurring: task.recurring,
    assignee: task.assignee,
    notes: task.notes,
    tags: task.tags
  });
}

/* ========== UI: HERO ========== */
function renderHero() {
  const s = S.stats;
  const avatar = s.level >= 50 ? '👑' : s.level >= 25 ? '🧙‍♂️' : s.level >= 10 ? '⚔️' : s.level >= 5 ? '🛡️' : '🧙';
  $('#avatar').textContent = avatar;
  const nameEl = $('#heroName');
  nameEl.textContent = S.name || 'Tap to set name';
  nameEl.title = 'Tap to change name';
  $('#levelNum').textContent = s.level;
  const xpPct = Math.min(100, (s.xpIntoLevel / s.xpToNext) * 100);
  $('#xpFill').style.width = `${xpPct}%`;
  $('#xpLabel').textContent = `${s.xpIntoLevel} / ${s.xpToNext} XP`;
  const hpPct = s.hp;
  $('#hpFill').style.width = `${hpPct}%`;
  $('#hpLabel').textContent = `❤️ ${s.hp} / 100 HP`;
  $('#streakVal').textContent = s.streak;
  $('#closedVal').textContent = s.closedCount;
  $('#openVal').textContent = s.openCount;
  $('#badgesVal').textContent = s.badges.size;
}

/* ========== UI: TASK CARD ========== */
function formatDeadline(deadline) {
  if (!deadline) return { text: 'no deadline', cls: '' };
  const d = new Date(deadline);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffH = diffMs / 3600000;
  const diffD = diffMs / 86400000;
  const sameDay = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (diffMs < 0) {
    const absH = Math.abs(diffH);
    if (absH < 24) return { text: `⏰ ${Math.round(absH)}h overdue`, cls: 'overdue' };
    return { text: `⚠️ ${Math.round(Math.abs(diffD))}d overdue`, cls: 'overdue' };
  }
  if (sameDay) return { text: `🎯 Today ${timeStr}`, cls: 'today' };
  if (diffD < 1) return { text: `⏰ In ${Math.round(diffH)}h`, cls: 'today' };
  if (diffD < 7) return { text: `📅 ${d.toLocaleDateString([], { weekday: 'short' })} ${timeStr}`, cls: '' };
  return { text: `📅 ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr}`, cls: '' };
}

function renderTaskCard(task, opts = {}) {
  const now = Date.now();
  const deadline = task.deadline ? new Date(task.deadline).getTime() : null;
  const isOverdue = task.state === 'open' && deadline && deadline < now;
  const isToday = task.state === 'open' && deadline && new Date(deadline).toDateString() === new Date().toDateString();
  const dl = formatDeadline(task.deadline);

  const card = el('div', `task ${isOverdue ? 'overdue' : ''} ${isToday && !isOverdue ? 'today' : ''} ${task.state === 'closed' ? 'closed' : ''}`);
  card.dataset.taskId = task.id;

  const checkHTML = task.state === 'closed'
    ? `<button class="task-check" title="Reopen" style="background:#22c55e;border-color:#22c55e;color:white">✓</button>`
    : `<button class="task-check" title="Complete"></button>`;

  const tagsHTML = task.tags.map(tname => {
    const lbl = S.labels.find(l => l.name === tname);
    const color = lbl ? `#${lbl.color}` : '#a78bfa';
    return `<span class="task-tag" style="background:${color}33;color:${color}">${escapeHTML(tname)}</span>`;
  }).join('');

  const recurringHTML = task.recurring && task.recurring !== 'none'
    ? `<span class="task-recurring">🔁 ${task.recurring}</span>` : '';

  const assigneeHTML = task.assignee
    ? `<span class="task-assignee">👤 ${escapeHTML(task.assignee)}</span>` : '';

  const imageUrls = extractImageUrls(task.notes);
  const textOnly = notesTextOnly(task.notes);
  const hasNotes = textOnly || imageUrls.length;

  const notesHTML = hasNotes
    ? `<div class="task-notes-wrap">
         <div class="task-notes-col">
           ${textOnly ? `<div class="task-notes">${escapeHTML(textOnly)}</div>` : ''}
           ${renderTaskImagesHTML(imageUrls)}
         </div>
         <button class="task-note-edit-btn" title="Edit note" aria-label="Edit note">✏️</button>
       </div>`
    : `<button class="task-add-note-btn" title="Add note or photo">📝 Add note</button>`;
  const photoBadgeHTML = imageUrls.length
    ? `<span class="task-photo-badge" title="${imageUrls.length} photo${imageUrls.length > 1 ? 's' : ''}">📷 ${imageUrls.length}</span>`
    : '';

  card.innerHTML = `
    ${checkHTML}
    <div class="task-body">
      <div class="task-title">${escapeHTML(task.title)}</div>
      <div class="task-meta">
        <span class="task-deadline ${dl.cls}">${dl.text}</span>
        ${assigneeHTML}
        ${tagsHTML}
        ${recurringHTML}
        ${photoBadgeHTML}
      </div>
      ${notesHTML}
    </div>
    <div class="task-actions">
      <button class="task-action-btn edit-btn" title="Edit">✏️</button>
      <button class="task-action-btn del-btn" title="Delete">🗑️</button>
    </div>
  `;

  card.querySelector('.task-check').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (task.state === 'closed') askReopenConfirm(task);
    else askCloseConfirm(task);
  });
  card.querySelector('.edit-btn').addEventListener('click', (ev) => { ev.stopPropagation(); openTaskModal(task); });
  card.querySelector('.del-btn').addEventListener('click', (ev) => { ev.stopPropagation(); deleteTaskFlow(task, card); });

  const notesEl = card.querySelector('.task-notes');
  if (notesEl) notesEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    notesEl.classList.toggle('expanded');
  });

  const noteEditBtn = card.querySelector('.task-note-edit-btn');
  if (noteEditBtn) noteEditBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    enterInlineNoteEdit(card, task);
  });

  const addNoteBtn = card.querySelector('.task-add-note-btn');
  if (addNoteBtn) addNoteBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    enterInlineNoteEdit(card, task);
  });

  card.querySelectorAll('.task-image-thumb').forEach(thumb => {
    thumb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const url = thumb.dataset.img;
      openLightbox(url, imageUrls);
    });
  });

  return card;
}

function enterInlineNoteEdit(card, task) {
  const body = card.querySelector('.task-body');
  if (!body || card.querySelector('.task-notes-edit')) return;

  const existing = task.notes || '';
  const existingText = notesTextOnly(existing);
  let currentPhotos = extractImageUrls(existing);

  const wrap = card.querySelector('.task-notes-wrap');
  const addBtn = card.querySelector('.task-add-note-btn');

  const editWrap = el('div', 'task-notes-edit-wrap');
  const ta = document.createElement('textarea');
  ta.className = 'task-notes-edit';
  ta.rows = 3;
  ta.value = existingText;
  ta.placeholder = 'Add a note… (tap outside to save, Esc to cancel)';

  const hint = el('div', 'task-notes-edit-hint', '<span class="note-save-status">📝 Editing…</span>');

  const photoCtl = createPhotoStrip({
    getUrls: () => currentPhotos,
    setUrls: (u) => { currentPhotos = u; }
  });

  editWrap.appendChild(ta);
  editWrap.appendChild(photoCtl.el);
  editWrap.appendChild(hint);

  if (wrap) wrap.replaceWith(editWrap);
  else if (addBtn) addBtn.replaceWith(editWrap);
  else body.appendChild(editWrap);

  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let done = false;
  let cancelled = false;

  const finish = async () => {
    if (done) return;
    // If photos are still uploading, wait a beat before saving
    if (photoCtl.isUploading()) {
      hint.querySelector('.note-save-status').textContent = '📷 Waiting for uploads…';
      const waitStart = Date.now();
      while (photoCtl.isUploading() && Date.now() - waitStart < 30000) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    done = true;
    const newText = cancelled ? existingText : ta.value.trim();
    const newNotes = cancelled ? existing : combineNotes(newText, currentPhotos);
    if (newNotes === existing) {
      renderAll();
      return;
    }
    ta.disabled = true;
    hint.querySelector('.note-save-status').textContent = '⏳ Saving…';
    try {
      const updated = await updateTask(task.id, {
        title: task.title,
        deadline: task.deadline,
        recurring: task.recurring,
        assignee: task.assignee,
        notes: newNotes,
        tags: task.tags
      });
      const idx = S.tasks.findIndex(t => t.id === task.id);
      if (idx >= 0 && updated) S.tasks[idx] = parseTask(updated);
      const rect = ta.getBoundingClientRect();
      sparkle(rect.left + rect.width / 2, rect.top + 8);
      playSound('add');
      renderAll();
      refresh().catch(() => {});
    } catch (e) {
      toast('Could not save note: ' + e.message, 'error');
      done = false;
      ta.disabled = false;
      hint.querySelector('.note-save-status').textContent = '⚠️ Retry';
    }
  };

  ta.addEventListener('blur', (e) => {
    // Ignore blur when focus is moving into the photo strip (add/remove buttons)
    const next = e.relatedTarget;
    if (next && editWrap.contains(next)) return;
    finish();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      ta.blur();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      ta.blur();
    }
  });
}

/* ========== UI: RENDER TABS ========== */
function renderAll() {
  renderHero();
  renderMineOpen();
  renderDelegatedOpen();
  renderDone();
  renderBadgesGrid();
  renderTabCounts();
}

function isOverdue(t) {
  return t.state === 'open' && t.deadline && new Date(t.deadline).getTime() < Date.now();
}

function renderOpenList(items, listEl, emptyEl, { enableTagFilter = false } = {}) {
  listEl.innerHTML = '';

  if (enableTagFilter) {
    if (S.activeTagFilter === '__overdue__') {
      items = items.filter(isOverdue);
    } else if (S.activeTagFilter) {
      items = items.filter(t => t.tags.includes(S.activeTagFilter));
    }
  }

  emptyEl.classList.toggle('hidden', items.length > 0);
  if (!items.length) return;

  const now = Date.now();
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const startTomorrow = new Date(startToday); startTomorrow.setDate(startTomorrow.getDate() + 1);
  const startDayAfter = new Date(startTomorrow); startDayAfter.setDate(startDayAfter.getDate() + 1);

  const sections = { overdue: [], today: [], tomorrow: [], upcoming: [], noDeadline: [] };
  for (const t of items) {
    if (!t.deadline) { sections.noDeadline.push(t); continue; }
    const d = new Date(t.deadline);
    if (d.getTime() < now) sections.overdue.push(t);
    else if (d >= startToday && d < startTomorrow) sections.today.push(t);
    else if (d >= startTomorrow && d < startDayAfter) sections.tomorrow.push(t);
    else sections.upcoming.push(t);
  }

  const byDeadline = (a, b) => new Date(a.deadline) - new Date(b.deadline);
  Object.values(sections).forEach(arr => arr.sort(byDeadline));

  const fmtDate = d => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  const addSection = (arr, icon, label, headerCls, dateStr) => {
    if (!arr.length) return;
    const header = el('div', `section-header ${headerCls}`);
    header.innerHTML = `<span>${icon} ${escapeHTML(label)}</span><span class="section-count">${arr.length}</span>${dateStr ? `<span class="section-date">${escapeHTML(dateStr)}</span>` : ''}`;
    listEl.appendChild(header);
    arr.forEach(t => listEl.appendChild(renderTaskCard(t)));
  };

  addSection(sections.overdue, '⚠️', 'OVERDUE', 'overdue');
  addSection(sections.today, '🎯', 'TODAY', 'today', fmtDate(startToday));
  addSection(sections.tomorrow, '📅', 'TOMORROW', 'tomorrow', fmtDate(startTomorrow));
  addSection(sections.upcoming, '🗓️', 'UPCOMING', 'upcoming');
  addSection(sections.noDeadline, '🕐', 'NO DEADLINE', '');
}

function renderMineOpen() {
  renderTagFilter();
  const items = S.tasks.filter(t => t.state === 'open' && !t.assignee);
  renderOpenList(items, $('#mineList'), $('#mineEmpty'), { enableTagFilter: true });
}

function renderDelegatedOpen() {
  const items = S.tasks.filter(t => t.state === 'open' && t.assignee);
  renderOpenList(items, $('#delegatedList'), $('#delegatedEmpty'), { enableTagFilter: false });
}

function renderTabCounts() {
  const mineOpen = S.tasks.filter(t => t.state === 'open' && !t.assignee).length;
  const delegatedOpen = S.tasks.filter(t => t.state === 'open' && t.assignee).length;
  const mineEl = $('#mineCount'); if (mineEl) mineEl.textContent = mineOpen ? `(${mineOpen})` : '';
  const delEl = $('#delegatedCount'); if (delEl) delEl.textContent = delegatedOpen ? `(${delegatedOpen})` : '';
}

function renderDone() {
  const list = $('#doneList'); list.innerHTML = '';
  const items = S.tasks.filter(t => t.state === 'closed')
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, 30);
  items.forEach(t => list.appendChild(renderTaskCard(t)));
  if (!items.length) list.innerHTML = '<div class="empty"><div class="empty-icon">✨</div><div class="empty-title">No closed quests yet</div><div class="empty-sub">Complete a quest to see it here.</div></div>';
}

function renderTagFilter() {
  const wrap = $('#tagFilter'); wrap.innerHTML = '';
  // Tag filter belongs to the Mine tab — only reflect self-assigned open tasks
  const openTasks = S.tasks.filter(t => t.state === 'open' && !t.assignee);
  const tagsInUse = new Set(openTasks.flatMap(t => t.tags));
  const overdueCount = openTasks.filter(isOverdue).length;

  // Inline "+ New Quest" button — primary CTA in the filter row
  const addBtn = el('button', 'filter-add-btn');
  addBtn.innerHTML = '<span style="font-size:16px;line-height:1">+</span> <span>New Quest</span>';
  addBtn.title = 'Add a new quest';
  addBtn.addEventListener('click', () => openTaskModal());
  wrap.appendChild(addBtn);

  const allChip = el('div', `tag-filter-chip ${!S.activeTagFilter ? 'active' : ''}`, 'All');
  allChip.addEventListener('click', () => { S.activeTagFilter = null; renderMineOpen(); });
  wrap.appendChild(allChip);

  if (overdueCount > 0) {
    const active = S.activeTagFilter === '__overdue__';
    const ovChip = el('div', `tag-filter-chip overdue-chip ${active ? 'active' : ''}`, `⚠️ Overdue (${overdueCount})`);
    ovChip.addEventListener('click', () => {
      S.activeTagFilter = active ? null : '__overdue__';
      renderMineOpen();
    });
    wrap.appendChild(ovChip);
  }

  [...tagsInUse].sort().forEach(tname => {
    const chip = el('div', `tag-filter-chip ${S.activeTagFilter === tname ? 'active' : ''}`, escapeHTML(tname));
    const lbl = S.labels.find(l => l.name === tname);
    if (lbl && S.activeTagFilter === tname) chip.style.background = `#${lbl.color}55`;
    chip.addEventListener('click', () => {
      S.activeTagFilter = S.activeTagFilter === tname ? null : tname;
      renderMineOpen();
    });
    wrap.appendChild(chip);
  });
}

function renderBadgesGrid() {
  const grid = $('#badgesGrid'); grid.innerHTML = '';
  BADGES.forEach(b => {
    const unlocked = S.stats.badges.has(b.id);
    const card = el('div', `badge-card ${unlocked ? 'unlocked' : 'locked'}`);
    card.innerHTML = `
      <div class="badge-card-icon">${unlocked ? b.icon : '🔒'}</div>
      <div class="badge-card-name">${b.name}</div>
      <div class="badge-card-desc">${b.desc}</div>
    `;
    grid.appendChild(card);
  });
}

/* ========== TASK MODAL ========== */
let modalPhotoCtl = null;

function openTaskModal(task = null) {
  S.editingTaskId = task ? task.id : null;
  S.selectedTags = new Set(task ? task.tags : []);
  $('#taskModalTitle').textContent = task ? '✏️ Edit Quest' : '⚔️ New Quest';
  $('#taskTitle').value = task ? task.title : '';
  $('#taskAssignee').value = task ? task.assignee || '' : '';
  $('#taskRecurring').value = task ? task.recurring || 'none' : 'none';
  const existingNotes = task ? task.notes : '';
  $('#taskNotes').value = notesTextOnly(existingNotes);
  $('#taskSubmitBtn .btn-label').textContent = task ? '💾 Save Changes' : '⚔️ Scribe Quest';

  // Photo strip
  const mount = $('#taskPhotoStripMount');
  mount.innerHTML = '';
  let photos = extractImageUrls(existingNotes);
  modalPhotoCtl = createPhotoStrip({
    getUrls: () => photos,
    setUrls: (u) => { photos = u; }
  });
  mount.appendChild(modalPhotoCtl.el);

  const pad = n => String(n).padStart(2, '0');
  const toLocalDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toLocalTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  let date, time;
  if (task && task.deadline) {
    const d = new Date(task.deadline);
    date = toLocalDate(d);
    time = toLocalTime(d);
  } else {
    date = toLocalDate(new Date());
    time = CONFIG.defaultTime;
  }
  $('#taskDate').value = date;
  $('#taskTime').value = time;
  renderTagChips();
  $('#taskModal').classList.remove('hidden');
  setTimeout(() => $('#taskTitle').focus(), 100);
}

function renderTagChips() {
  const wrap = $('#tagChips'); wrap.innerHTML = '';
  const tagLabels = S.labels.filter(l =>
    l.name !== CONFIG.stateLabel &&
    !l.name.startsWith(CONFIG.recurringPrefix) &&
    l.name !== 'deleted'
  );
  if (!tagLabels.length) {
    wrap.innerHTML = '<div style="color:#7e72a0;font-size:12px">No tags yet. Add one below.</div>';
    return;
  }
  tagLabels.sort((a, b) => a.name.localeCompare(b.name)).forEach(lbl => {
    const chip = el('div', `tag-chip ${S.selectedTags.has(lbl.name) ? 'selected' : ''}`, escapeHTML(lbl.name));
    const color = `#${lbl.color}`;
    if (S.selectedTags.has(lbl.name)) {
      chip.style.background = `${color}55`;
      chip.style.borderColor = color;
      chip.style.color = '#fff';
    }
    chip.addEventListener('click', () => {
      if (S.selectedTags.has(lbl.name)) S.selectedTags.delete(lbl.name);
      else S.selectedTags.add(lbl.name);
      renderTagChips();
    });
    wrap.appendChild(chip);
  });
}

async function handleTaskSubmit(ev) {
  ev.preventDefault();
  const btn = $('#taskSubmitBtn');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = '⏳ Saving…';
  try {
    const title = $('#taskTitle').value.trim();
    const dateStr = $('#taskDate').value;
    const timeStr = $('#taskTime').value || CONFIG.defaultTime;
    if (!title || !dateStr) { toast('Title and date are required', 'error'); return; }
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [hh, mm] = timeStr.split(':').map(Number);
    if (!y || !mo || !d) { toast('Invalid date', 'error'); return; }
    const deadlineDate = new Date(y, mo - 1, d, isNaN(hh) ? 18 : hh, isNaN(mm) ? 30 : mm, 0, 0);
    const deadline = deadlineDate.toISOString();
    // Wait for any in-flight photo uploads
    if (modalPhotoCtl && modalPhotoCtl.isUploading()) {
      btn.querySelector('.btn-label').textContent = '📷 Uploading photos…';
      const waitStart = Date.now();
      while (modalPhotoCtl.isUploading() && Date.now() - waitStart < 60000) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    const modalPhotos = modalPhotoCtl ? (() => {
      // Scrape URLs from the strip's DOM via createPhotoStrip's closure — use simpler approach: re-read from DOM backgrounds
      return [...modalPhotoCtl.el.querySelectorAll('.photo-preview-item:not(.uploading)')].map(it => {
        const bg = it.style.backgroundImage;
        const m = bg.match(/url\(['"]?([^'")]+)['"]?\)/);
        return m ? m[1] : null;
      }).filter(Boolean);
    })() : [];
    const textNotes = $('#taskNotes').value.trim();
    const data = {
      title,
      deadline,
      recurring: $('#taskRecurring').value,
      assignee: $('#taskAssignee').value.trim(),
      notes: combineNotes(textNotes, modalPhotos),
      tags: [...S.selectedTags]
    };
    if (S.editingTaskId) {
      const updated = await updateTask(S.editingTaskId, data);
      const idx = S.tasks.findIndex(t => t.id === S.editingTaskId);
      if (idx >= 0 && updated) S.tasks[idx] = parseTask(updated);
      S.stats = computeStats(S.tasks);
      renderAll();
      toast('Quest updated ✓', 'success');
    } else {
      const created = await createTask(data);
      if (created) {
        const newTask = parseTask(created);
        S.tasks.unshift(newTask);
        S.stats = computeStats(S.tasks);
        renderAll();
      }
      floatXPAt('+5 XP', window.innerWidth / 2, window.innerHeight / 2);
      sparkle(window.innerWidth / 2, window.innerHeight / 2);
      playSound('add');
      toast('⚔️ Quest scribed!', 'success');
    }
    closeModals();
    refresh().catch(() => {});
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ========== CLOSE / REOPEN / DELETE ========== */
function askCloseConfirm(task) {
  S.pendingCloseTask = task;
  // Delegated tasks are tracking-only — no XP so the reward display is skipped.
  const xp = task.assignee ? 0 : computeCloseXP({ ...task, closedAt: new Date().toISOString() });
  $('#confirmCloseTitle').textContent = task.title;
  $('#confirmCloseXP').textContent = xp;
  const isLate = task.deadline && new Date(task.deadline).getTime() < Date.now();
  $('#confirmCloseSub').textContent = task.assignee
    ? `Marking delegated quest for ${task.assignee} as done.`
    : isLate
      ? 'Better late than never — claim your reward!'
      : 'Victory awaits, adventurer!';
  $('#closeModal').classList.remove('hidden');
  playSound('add');
}

async function doCloseTask() {
  const task = S.pendingCloseTask;
  if (!task) return;
  S.pendingCloseTask = null;

  const btn = $('#confirmCloseBtn');
  btn.disabled = true;

  const card = document.querySelector(`.task[data-task-id="${task.id}"]`);
  if (card) card.classList.add('closing');

  const rect = card ? card.getBoundingClientRect() : null;
  const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const xpReward = task.assignee ? 0 : computeCloseXP({ ...task, closedAt: new Date().toISOString() });

  $('#closeModal').classList.add('hidden');
  if (xpReward > 0) floatXPAt(`+${xpReward} XP`, cx, cy);
  else floatXPAt(`✓ Done`, cx, cy);
  burstConfetti(cx / window.innerWidth, cy / window.innerHeight);
  setTimeout(() => burstConfetti(Math.random(), Math.random() * 0.3), 150);
  playSound('complete');

  try {
    const closed = await closeTaskApi(task.id);
    const idx = S.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0 && closed) S.tasks[idx] = parseTask(closed);
    if (task.recurring && task.recurring !== 'none') {
      const created = await handleRecurring(task);
      if (created) S.tasks.unshift(parseTask(created));
    }
    const oldStats = S.stats;
    S.stats = computeStats(S.tasks);
    if (oldStats && S.stats.level > oldStats.level) showLevelUp(S.stats.level);
    if (oldStats) {
      for (const id of S.stats.badges) {
        if (!oldStats.badges.has(id)) {
          const b = BADGES.find(bb => bb.id === id);
          if (b) showBadge(b);
        }
      }
    }
    setTimeout(() => renderAll(), 400);
    refresh().catch(() => {});
  } catch (e) {
    if (card) card.classList.remove('closing');
    toast('Could not close: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function askReopenConfirm(task) {
  S.pendingReopenTask = task;
  const xp = task.assignee ? 0 : computeCloseXP(task);
  $('#confirmReopenTitle').textContent = task.title;
  $('#confirmReopenXP').textContent = xp;
  $('#reopenModal').classList.remove('hidden');
}

async function doReopenTask() {
  const task = S.pendingReopenTask;
  if (!task) return;
  S.pendingReopenTask = null;
  const btn = $('#confirmReopenBtn');
  btn.disabled = true;
  $('#reopenModal').classList.add('hidden');

  const xpLoss = task.assignee ? 0 : computeCloseXP(task);
  if (xpLoss > 0) {
    floatLossAt(`−${xpLoss} XP`, window.innerWidth / 2, window.innerHeight * 0.4);
    const hpBar = document.querySelector('.hp-bar');
    if (hpBar) {
      hpBar.classList.add('hp-hit');
      setTimeout(() => hpBar.classList.remove('hp-hit'), 600);
    }
  }
  playSound('add');

  // Find the card and fly it toward the tab it's landing in (Mine or Delegated)
  const targetTabName = task.assignee ? 'delegated' : 'mine';
  const sourceCard = document.querySelector(`.task[data-task-id="${task.id}"]`);
  const flight = sourceCard ? flyCardToTab(sourceCard, targetTabName) : Promise.resolve();

  try {
    const reopened = await reopenTaskApi(task.id);
    const idx = S.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0 && reopened) S.tasks[idx] = parseTask(reopened);
    S.stats = computeStats(S.tasks);

    pulseTab(targetTabName);

    await flight;
    renderAll();
    toast(`↩️ Quest reopened → ${targetTabName === 'delegated' ? 'Delegated' : 'Mine'} tab  •  ${task.assignee ? '' : `−${xpLoss} XP`}`, 'error');
    refresh().catch(() => {});
  } catch (e) {
    toast('Could not reopen: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function flyCardToTab(card, tabName) {
  return new Promise(resolve => {
    const targetTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (!targetTab) { resolve(); return; }
    const cardRect = card.getBoundingClientRect();
    const tabRect = targetTab.getBoundingClientRect();
    const dx = (tabRect.left + tabRect.width / 2) - (cardRect.left + cardRect.width / 2);
    const dy = (tabRect.top + tabRect.height / 2) - (cardRect.top + cardRect.height / 2);

    const clone = card.cloneNode(true);
    clone.style.position = 'fixed';
    clone.style.left = cardRect.left + 'px';
    clone.style.top = cardRect.top + 'px';
    clone.style.width = cardRect.width + 'px';
    clone.style.margin = '0';
    clone.style.zIndex = '350';
    clone.style.pointerEvents = 'none';
    clone.style.transition = 'transform 0.85s cubic-bezier(0.65, 0, 0.35, 1), opacity 0.85s';
    clone.style.transformOrigin = 'center center';
    document.body.appendChild(clone);

    // Hide original
    card.style.visibility = 'hidden';

    // Spawn a few sparkles along the path
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      setTimeout(() => {
        const t = (i + 1) / (steps + 1);
        sparkle(
          cardRect.left + cardRect.width / 2 + dx * t,
          cardRect.top + cardRect.height / 2 + dy * t
        );
      }, 80 + i * 140);
    }

    requestAnimationFrame(() => {
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(0.08) rotate(22deg)`;
      clone.style.opacity = '0';
    });

    setTimeout(() => {
      clone.remove();
      resolve();
    }, 900);
  });
}

function pulseTab(tabName) {
  const t = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!t) return;
  t.classList.add('tab-receiving');
  setTimeout(() => t.classList.remove('tab-receiving'), 900);
}

async function deleteTaskFlow(task, card) {
  if (!confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
  card.classList.add('removing');
  try {
    await deleteTaskApi(task.id);
    S.tasks = S.tasks.filter(t => t.id !== task.id);
    S.stats = computeStats(S.tasks);
    setTimeout(() => renderAll(), 300);
    refresh().catch(() => {});
  } catch (e) {
    card.classList.remove('removing');
    toast('Could not delete: ' + e.message, 'error');
  }
}

/* ========== TAG MANAGER ========== */
function openTagManager() {
  renderTagManagerList();
  $('#tagModal').classList.remove('hidden');
}

function renderTagManagerList() {
  const wrap = $('#tagList'); wrap.innerHTML = '';
  const tags = S.labels.filter(l =>
    l.name !== CONFIG.stateLabel &&
    !l.name.startsWith(CONFIG.recurringPrefix) &&
    l.name !== 'deleted'
  ).sort((a, b) => a.name.localeCompare(b.name));
  if (!tags.length) {
    wrap.innerHTML = '<div style="color:#7e72a0;text-align:center;padding:20px">No tags yet. Create one below.</div>';
    return;
  }
  tags.forEach(lbl => {
    const row = el('div', 'tag-row');
    row.innerHTML = `
      <span class="tag-dot" style="background:#${lbl.color}"></span>
      <input type="text" value="${escapeHTML(lbl.name)}" data-old="${escapeHTML(lbl.name)}" />
      <input type="color" value="#${lbl.color}" />
      <button class="icon-btn del-tag" title="Delete tag">🗑️</button>
    `;
    const [nameInput, colorInput] = row.querySelectorAll('input');
    const delBtn = row.querySelector('.del-tag');
    let saveTimer;
    const saveRow = async () => {
      const oldName = nameInput.dataset.old;
      const newName = nameInput.value.trim();
      const color = colorInput.value;
      if (!newName || (newName === oldName && `#${lbl.color}` === color)) return;
      try {
        await updateLabel(oldName, newName, color);
        toast('Tag updated ✓', 'success');
        await loadLabels();
        renderTagManagerList();
      } catch (e) { toast('Error: ' + e.message, 'error'); }
    };
    nameInput.addEventListener('blur', saveRow);
    colorInput.addEventListener('change', saveRow);
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete tag "${lbl.name}"? It will be removed from all tasks.`)) return;
      try {
        await deleteLabelApi(lbl.name);
        toast('Tag deleted', 'success');
        await loadLabels();
        await refresh();
        renderTagManagerList();
      } catch (e) { toast('Error: ' + e.message, 'error'); }
    });
    wrap.appendChild(row);
  });
}

/* ========== ANIMATIONS ========== */
function burstConfetti(xRatio = 0.5, yRatio = 0.5) {
  if (typeof confetti === 'undefined') return;
  confetti({
    particleCount: 80,
    spread: 70,
    origin: { x: xRatio, y: yRatio },
    colors: ['#ffd700', '#ff9e00', '#a78bfa', '#22c55e', '#ff4d6d']
  });
}

function floatXPAt(text, x, y) {
  const f = el('div', 'xp-float', text);
  f.style.left = `${x}px`;
  f.style.top = `${y}px`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1300);
}

function floatLossAt(text, x, y) {
  const f = el('div', 'xp-float xp-loss', text);
  f.style.left = `${x}px`;
  f.style.top = `${y}px`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1300);
}

function sparkle(x, y) {
  for (let i = 0; i < 6; i++) {
    const s = el('div', '', '✨');
    s.style.cssText = `position:fixed;left:${x}px;top:${y}px;font-size:24px;pointer-events:none;z-index:500;animation:sparkle 0.8s ease-out forwards;`;
    const angle = (i / 6) * Math.PI * 2;
    s.style.transform = `translate(${Math.cos(angle) * 40}px, ${Math.sin(angle) * 40}px)`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 800);
  }
}

function showLevelUp(newLevel) {
  $('#levelUpNum').textContent = newLevel;
  $('#levelUpModal').classList.remove('hidden');
  for (let i = 0; i < 3; i++) setTimeout(() => burstConfetti(0.5, 0.5), i * 250);
  playSound('levelup');
}

function showBadge(badge) {
  $('#badgeToastIcon').textContent = badge.icon;
  $('#badgeToastName').textContent = badge.name;
  $('#badgeToast').classList.remove('hidden');
  burstConfetti(0.5, 0.2);
  playSound('badge');
  setTimeout(() => $('#badgeToast').classList.add('hidden'), 3500);
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('hidden'), 2500);
}

/* ========== SOUND ========== */
let audioCtx = null;
function playSound(kind) {
  if (!S.soundOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    gain.gain.setValueAtTime(0.06, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    if (kind === 'complete') {
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
    } else if (kind === 'add') {
      osc.frequency.setValueAtTime(800, now);
    } else if (kind === 'levelup') {
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.1);
      osc.frequency.setValueAtTime(783.99, now + 0.2);
      osc.frequency.setValueAtTime(1046.5, now + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    } else if (kind === 'badge') {
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1320, now + 0.1);
    }
    osc.start(now);
    osc.stop(now + 0.8);
  } catch (e) { /* ignore */ }
}

/* ========== MODALS ========== */
function closeModals() {
  $$('.modal').forEach(m => m.classList.add('hidden'));
  $('#levelUpModal').classList.add('hidden');
}

/* ========== LOAD ========== */
async function loadLabels() {
  S.labels = await fetchLabels();
}

async function refresh() {
  const issues = await fetchAllIssues();
  const serverTasks = issues
    .map(parseTask)
    .filter(t => !(t.issue.labels || []).some(l => l.name === 'deleted'));

  // Merge: preserve any locally-added task that server's list API hasn't
  // indexed yet (GitHub list endpoint has eventual consistency of several
  // seconds). Without this the UI flickers: new task appears, then vanishes
  // when background refresh returns a list that hasn't yet picked it up.
  const serverIds = new Set(serverTasks.map(t => t.id));
  const now = Date.now();
  const pendingLocal = S.tasks.filter(t =>
    !serverIds.has(t.id) &&
    t.createdAt &&
    (now - new Date(t.createdAt).getTime()) < 60_000
  );
  S.tasks = pendingLocal.length
    ? [...pendingLocal, ...serverTasks]
    : serverTasks;

  const oldStats = S.stats;
  S.stats = computeStats(S.tasks);

  if (oldStats) {
    if (S.stats.level > oldStats.level) showLevelUp(S.stats.level);
    for (const badgeId of S.stats.badges) {
      if (!oldStats.badges.has(badgeId)) {
        const b = BADGES.find(bb => bb.id === badgeId);
        if (b) showBadge(b);
      }
    }
  }
  renderAll();
  S.lastRefreshAt = Date.now();
  markStaleIfNeeded();
}

async function loadEverything() {
  $('#loadingText').textContent = 'Loading labels…';
  await loadLabels();
  $('#loadingText').textContent = 'Setting up labels…';
  await ensureBaseLabels();
  $('#loadingText').textContent = 'Loading quests…';
  await refresh();
  S.lastRefreshAt = Date.now();
  $('#loadingScreen').classList.add('gone');
  setTimeout(() => $('#loadingScreen').style.display = 'none', 400);
  startAutoRefresh();
  initGcal().catch(() => {});
}

async function userRefresh({ silent = false } = {}) {
  if (!S.token) return;
  const btn = $('#refreshHeroBtn');
  if (btn) {
    btn.classList.remove('stale');
    btn.classList.add('spinning');
  }
  try {
    await refresh();
    S.lastRefreshAt = Date.now();
    if (!silent) {
      const rect = btn ? btn.getBoundingClientRect() : null;
      const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const cy = rect ? rect.bottom + 10 : 80;
      floatXPAt('⚡ Synced', cx, cy);
      playSound('add');
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(r => r && r.update && r.update()).catch(() => {});
    }
  } catch (e) {
    if (!silent) toast('Refresh failed: ' + e.message, 'error');
  } finally {
    setTimeout(() => btn && btn.classList.remove('spinning'), 800);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  S.autoRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && S.token) {
      userRefresh({ silent: true }).catch(() => {});
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (S.autoRefreshTimer) { clearInterval(S.autoRefreshTimer); S.autoRefreshTimer = null; }
}

function markStaleIfNeeded() {
  const btn = $('#refreshHeroBtn');
  if (!btn) return;
  const stale = S.lastRefreshAt && (Date.now() - S.lastRefreshAt > 120_000);
  btn.classList.toggle('stale', !!stale);
}
setInterval(markStaleIfNeeded, 10_000);

/* ========== TABS ========== */
function switchTab(tab) {
  S.activeTab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
}

/* ========== LOGIN / LOGOUT ========== */
async function tryLogin(token) {
  const ok = await verifyToken(token);
  if (!ok) throw new Error('Invalid token or no access to repo');
  localStorage.setItem('ghToken', token);
  S.token = token;
}

async function onLogin() {
  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = '⏳ Verifying…';
  try {
    const name = $('#nameInput').value.trim();
    const token = $('#tokenInput').value.trim();
    if (!token) throw new Error('Enter a token');
    await tryLogin(token);
    if (name) {
      localStorage.setItem('questName', name);
      S.name = name;
    }
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#loadingScreen').classList.remove('gone');
    $('#loadingScreen').style.display = 'flex';
    await loadEverything();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = '⚡ Begin Adventure';
  }
}

function logout() {
  if (!confirm('Logout and clear token? Your quests in GitHub stay untouched.')) return;
  localStorage.removeItem('ghToken');
  localStorage.removeItem('questName');
  S.token = null;
  S.name = '';
  location.reload();
}

function changeName() {
  const current = S.name || '';
  const next = prompt('What shall we call you, adventurer?', current);
  if (next === null) return;
  const trimmed = next.trim();
  if (trimmed) {
    S.name = trimmed;
    localStorage.setItem('questName', trimmed);
  } else {
    S.name = '';
    localStorage.removeItem('questName');
  }
  if (S.stats) renderHero();
}

/* ========== PWA INSTALL ========== */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.deferredInstall = e;
});

async function installApp() {
  if (!S.deferredInstall) { toast('Use your browser\'s "Add to Home Screen" from the share menu', 'error'); return; }
  S.deferredInstall.prompt();
  const { outcome } = await S.deferredInstall.userChoice;
  if (outcome === 'accepted') toast('Installed! ✨', 'success');
  S.deferredInstall = null;
}

/* ========== EVENT WIRING ========== */
function wireEvents() {
  $('#loginBtn').addEventListener('click', onLogin);
  $('#tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') onLogin(); });

  $('#fab').addEventListener('click', () => openTaskModal());
  $('#menuBtn').addEventListener('click', () => $('#menuModal').classList.remove('hidden'));
  $('#heroName').addEventListener('click', () => changeName());
  $('#avatar').addEventListener('click', () => changeName());
  $('#taskForm').addEventListener('submit', handleTaskSubmit);

  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#addNewTagBtn').addEventListener('click', async () => {
    const input = $('#newTagInput');
    const name = input.value.trim();
    if (!name) return;
    try {
      await createLabel(name, '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
      await loadLabels();
      S.selectedTags.add(name);
      input.value = '';
      renderTagChips();
      toast('Tag created ✓', 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });
  $('#newTagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#addNewTagBtn').click(); }
  });
  $('#manageTagsBtn').addEventListener('click', openTagManager);

  $('#tagManagerAddBtn').addEventListener('click', async () => {
    const name = $('#tagManagerNewInput').value.trim();
    const color = $('#tagManagerNewColor').value;
    if (!name) return;
    try {
      await createLabel(name, color);
      $('#tagManagerNewInput').value = '';
      await loadLabels();
      renderTagManagerList();
      toast('Tag created ✓', 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  $('#refreshHeroBtn').addEventListener('click', () => userRefresh({ silent: false }));

  $('#gcalRefreshBtn')?.addEventListener('click', async () => {
    const btn = $('#gcalRefreshBtn');
    btn.classList.add('spinning');
    await refreshMeetings();
    setTimeout(() => btn.classList.remove('spinning'), 800);
  });
  document.querySelectorAll('.gcal-range-btn').forEach(btn => {
    btn.addEventListener('click', () => setGcalRange(btn.dataset.range));
  });
  document.querySelectorAll('.gcal-range-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === S.gcalRange);
  });
  $('#refreshBtn').addEventListener('click', () => { closeModals(); userRefresh({ silent: false }); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.token) {
      if (!S.lastRefreshAt || Date.now() - S.lastRefreshAt > STALE_THRESHOLD_MS) {
        userRefresh({ silent: true }).catch(() => {});
      }
      refreshMeetings().catch(() => {});
    }
  });
  window.addEventListener('focus', () => {
    if (S.token && (!S.lastRefreshAt || Date.now() - S.lastRefreshAt > STALE_THRESHOLD_MS)) {
      userRefresh({ silent: true }).catch(() => {});
    }
    refreshMeetings().catch(() => {});
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && S.token) userRefresh({ silent: true }).catch(() => {});
    if (e.persisted) refreshMeetings().catch(() => {});
  });
  $('#soundToggleBtn').addEventListener('click', () => {
    S.soundOn = !S.soundOn;
    localStorage.setItem('soundOn', S.soundOn);
    $('#soundToggleBtn').textContent = `🔊 Sound: ${S.soundOn ? 'On' : 'Off'}`;
  });
  $('#soundToggleBtn').textContent = `🔊 Sound: ${S.soundOn ? 'On' : 'Off'}`;
  $('#tagManagerOpenBtn').addEventListener('click', () => { closeModals(); openTagManager(); });
  $('#changeNameBtn').addEventListener('click', () => { closeModals(); changeName(); });
  $('#installBtn').addEventListener('click', installApp);
  $('#logoutBtn').addEventListener('click', logout);
  $('#levelUpClose').addEventListener('click', () => $('#levelUpModal').classList.add('hidden'));
  $('#confirmCloseBtn').addEventListener('click', doCloseTask);
  $('#confirmReopenBtn').addEventListener('click', doReopenTask);

  $$('[data-close-modal]').forEach(b => b.addEventListener('click', closeModals));
  $$('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
  });
}

/* ========== PHOTO ATTACHMENTS ========== */

const MAX_PHOTOS_PER_TASK = 10;
const MAX_PHOTO_DIMENSION = 1600;
const PHOTO_JPEG_QUALITY = 0.85;

async function compressImage(file) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Could not decode image'));
    i.src = URL.createObjectURL(file);
  });
  let { width, height } = img;
  const max = Math.max(width, height);
  if (max > MAX_PHOTO_DIMENSION) {
    const scale = MAX_PHOTO_DIMENSION / max;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(img.src);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', PHOTO_JPEG_QUALITY));
  if (!blob) throw new Error('Compression failed');
  return blob;
}

async function uploadImageToRepo(blob, originalName) {
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsDataURL(blob);
  });
  const stem = (originalName || 'photo')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '_')
    .slice(0, 30) || 'photo';
  const filename = `${Date.now()}-${stem}.jpg`;
  const path = `images/${filename}`;
  const res = await gh(`/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`, 'PUT', {
    message: `Add quest image ${filename}`,
    content: base64
  });
  return res.content.download_url;
}

function extractImageUrls(notes) {
  if (!notes) return [];
  const regex = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  const urls = [];
  let m;
  while ((m = regex.exec(notes)) !== null) urls.push(m[1]);
  return urls;
}

function notesTextOnly(notes) {
  if (!notes) return '';
  return notes
    .replace(/!\[[^\]]*\]\([^)\s]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function combineNotes(text, imageUrls) {
  const parts = [];
  const t = (text || '').trim();
  if (t) parts.push(t);
  if (imageUrls && imageUrls.length) {
    parts.push(imageUrls.map(u => `![photo](${u})`).join('\n'));
  }
  return parts.join('\n\n');
}

function renderTaskImagesHTML(urls) {
  if (!urls || !urls.length) return '';
  const shown = urls.slice(0, 4);
  const extra = urls.length - shown.length;
  const thumbs = shown.map((u, i) => {
    const isLast = (i === shown.length - 1) && extra > 0;
    const overlay = isLast ? `<div class="task-image-more-overlay">+${extra}</div>` : '';
    return `<div class="task-image-thumb" style="background-image:url('${escapeHTML(u)}')" data-img="${escapeHTML(u)}" data-nobubble>${overlay}</div>`;
  }).join('');
  return `<div class="task-images" data-nobubble>${thumbs}</div>`;
}

/* ========== LIGHTBOX ========== */
function openLightbox(url, allUrls) {
  const urls = (allUrls && allUrls.length) ? allUrls : [url];
  let idx = Math.max(0, urls.indexOf(url));
  const lb = document.createElement('div');
  lb.className = 'lightbox';

  const render = () => {
    lb.innerHTML = `
      <button class="lightbox-close" aria-label="Close">✕</button>
      ${urls.length > 1 ? `
        <button class="lightbox-nav lightbox-prev" aria-label="Previous">‹</button>
        <button class="lightbox-nav lightbox-next" aria-label="Next">›</button>
        <div class="lightbox-counter">${idx + 1} / ${urls.length}</div>
      ` : ''}
      <img src="${escapeHTML(urls[idx])}" alt="quest photo" />
    `;
    lb.querySelector('.lightbox-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    const prev = lb.querySelector('.lightbox-prev');
    const next = lb.querySelector('.lightbox-next');
    if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); idx = (idx - 1 + urls.length) % urls.length; render(); });
    if (next) next.addEventListener('click', (e) => { e.stopPropagation(); idx = (idx + 1) % urls.length; render(); });
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    lb.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') { idx = (idx - 1 + urls.length) % urls.length; render(); }
    else if (e.key === 'ArrowRight') { idx = (idx + 1) % urls.length; render(); }
  };
  lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
  document.addEventListener('keydown', onKey);
  render();
  document.body.appendChild(lb);
}

/* ========== PHOTO STRIP (shared by modal + inline editor) ========== */
function createPhotoStrip({ getUrls, setUrls, onChange }) {
  const strip = document.createElement('div');
  strip.className = 'photo-strip';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  try { fileInput.capture = 'environment'; } catch {}
  fileInput.style.display = 'none';

  const renderStrip = () => {
    const urls = getUrls();
    strip.innerHTML = '';
    urls.forEach((url) => {
      const item = document.createElement('div');
      item.className = 'photo-preview-item';
      item.style.backgroundImage = `url('${url}')`;
      item.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(url, getUrls()); });
      const rm = document.createElement('button');
      rm.className = 'photo-remove-btn';
      rm.textContent = '✕';
      rm.title = 'Remove photo';
      rm.addEventListener('mousedown', e => e.preventDefault());
      rm.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const next = getUrls().filter(u => u !== url);
        setUrls(next);
        renderStrip();
        onChange && onChange();
      });
      item.appendChild(rm);
      strip.appendChild(item);
    });
    if (urls.length < MAX_PHOTOS_PER_TASK) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'photo-add-btn';
      add.innerHTML = '<span class="photo-add-ico">📷</span><span class="photo-add-plus">+</span>';
      add.title = 'Attach or take photo';
      // prevent blur of inline textarea when clicking the button
      add.addEventListener('mousedown', e => e.preventDefault());
      add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fileInput.click(); });
      strip.appendChild(add);
    }
    strip.appendChild(fileInput);
  };

  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;
    const slots = MAX_PHOTOS_PER_TASK - getUrls().length;
    if (slots <= 0) { toast('Max 10 photos per quest', 'error'); return; }
    const batch = files.slice(0, slots);
    if (files.length > slots) toast(`Only ${slots} more photo(s) allowed`, 'error');

    // Add placeholders
    const placeholders = [];
    const addBtn = strip.querySelector('.photo-add-btn');
    batch.forEach(() => {
      const ph = document.createElement('div');
      ph.className = 'photo-preview-item uploading';
      ph.innerHTML = '<div class="photo-spinner">⚔️</div>';
      strip.insertBefore(ph, addBtn || null);
      placeholders.push(ph);
    });
    strip.classList.add('is-uploading');

    let completed = 0;
    const uploads = batch.map(async (file, i) => {
      try {
        const blob = await compressImage(file);
        const url = await uploadImageToRepo(blob, file.name);
        completed++;
        return url;
      } catch (e) {
        console.error(e);
        toast('Upload failed: ' + e.message, 'error');
        return null;
      }
    });
    const urls = (await Promise.all(uploads)).filter(Boolean);
    setUrls([...getUrls(), ...urls]);
    strip.classList.remove('is-uploading');
    renderStrip();
    if (urls.length) {
      sparkle(window.innerWidth / 2, window.innerHeight / 2);
      playSound('add');
    }
    onChange && onChange();
  });

  renderStrip();
  return { el: strip, refresh: renderStrip, isUploading: () => strip.classList.contains('is-uploading') };
}

/* ========== GOOGLE CALENDAR (iCal JSON, no OAuth) ==========
 * Meetings are fetched from a committed `meetings.json` that a GitHub Action
 * refreshes every 15 min from GCAL_ICAL_URL. Replaces the previous Google
 * Identity Services flow, which issued 1-hour access tokens with no refresh
 * token — silent re-auth was blocked by third-party cookie policies, so the
 * app kept "logging out" every hour. Same-origin fetch → no CORS, no OAuth,
 * no expiry.
 */
const GCAL_MEETINGS_POLL_MS = 5 * 60 * 1000;
const MEETINGS_JSON_URL = 'meetings.json';

async function fetchMeetingsJson() {
  // Cache-buster so we always see the newest commit from the Action.
  const url = `${MEETINGS_JSON_URL}?t=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) {
    // meetings.json not yet committed — Action may not have run yet
    return { events: [], generatedAt: null, missing: true };
  }
  if (!res.ok) throw new Error(`meetings.json ${res.status}`);
  return res.json();
}

function getGcalRangeBounds() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const r = S.gcalRange;
  if (r === 'past') {
    const start = new Date(today); start.setDate(start.getDate() - 7);
    return { start, end: today, label: 'Last 7 days' };
  }
  if (r === 'week') {
    const start = new Date(today); start.setDate(start.getDate() + 2);
    const end = new Date(today); end.setDate(end.getDate() + 8);
    return { start, end, label: 'Day after tomorrow → next week' };
  }
  // upcoming default
  const end = new Date(today); end.setDate(end.getDate() + 2);
  return { start: today, end, label: 'Today + Tomorrow' };
}

async function refreshMeetings() {
  try {
    const data = await fetchMeetingsJson();
    // Client-side filters: the JSON covers ±7 days; renderMeetings slices by
    // the currently-selected range. Cancelled events are already stripped upstream.
    S.gcalMeetings = data.events || [];
    S.gcalGeneratedAt = data.generatedAt || null;
    S.gcalStatus = data.missing ? 'loading' : 'ready';
  } catch (e) {
    console.warn('meetings.json fetch failed', e);
    S.gcalStatus = 'error';
  }
  renderMeetings();
  updateGcalCountdown();
}

function setGcalRange(range) {
  S.gcalRange = range;
  localStorage.setItem('gcalRange', range);
  document.querySelectorAll('.gcal-range-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.range === range);
  });
  refreshMeetings().catch(() => {});
}

function startGcalPolling() {
  stopGcalPolling();
  S.gcalTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshMeetings().catch(() => {});
    }
  }, GCAL_MEETINGS_POLL_MS);
}

function stopGcalPolling() {
  if (S.gcalTimer) { clearInterval(S.gcalTimer); S.gcalTimer = null; }
}

function getMeetingLink(event) {
  // meetings.json pre-extracts the meet/zoom/teams URL; fall back to hangoutLink
  // or a regex scan of location+description for older payloads.
  if (event.meetLink) return event.meetLink;
  if (event.hangoutLink) return { url: event.hangoutLink, type: 'meet', label: 'Meet' };
  const text = [event.location || '', event.description || ''].join(' ');
  const patterns = [
    { re: /https?:\/\/[^\s<>"']*zoom\.us\/[^\s<>"']+/i, type: 'zoom', label: 'Zoom' },
    { re: /https?:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/[^\s<>"']+/i, type: 'teams', label: 'Teams' },
    { re: /https?:\/\/meet\.google\.com\/[^\s<>"']+/i, type: 'meet', label: 'Meet' }
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return { url: m[0].replace(/[.,;)]+$/, ''), type: p.type, label: p.label };
  }
  return null;
}

function renderMeetings() {
  const list = $('#meetingsList');
  const empty = $('#meetingsEmpty');
  const nav = $('#gcalRangeNav');
  const rangeLabel = $('#gcalRangeLabel');
  if (!list) return;

  if (S.gcalStatus === 'loading') {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    nav.classList.add('hidden');
    rangeLabel.classList.add('hidden');
    const emptyText = $('#meetingsEmptyText');
    if (emptyText) emptyText.textContent = 'Loading meetings…';
    return;
  }
  if (S.gcalStatus === 'error') {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    nav.classList.add('hidden');
    rangeLabel.classList.add('hidden');
    const emptyText = $('#meetingsEmptyText');
    if (emptyText) emptyText.textContent = 'Could not load meetings.json — the refresh Action may not have run yet. It updates every 15 min.';
    return;
  }

  nav.classList.remove('hidden');
  rangeLabel.classList.remove('hidden');

  const bounds = getGcalRangeBounds();
  const fmtDate = d => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  const endVisible = new Date(bounds.end); endVisible.setDate(endVisible.getDate() - 1);
  rangeLabel.textContent = `📅 ${bounds.label} · ${fmtDate(bounds.start)} – ${fmtDate(endVisible)}`;

  list.innerHTML = '';
  // meetings.json covers ±7 days; slice by the active range here.
  const rangeStart = bounds.start.getTime();
  const rangeEnd = bounds.end.getTime();
  const events = S.gcalMeetings
    .filter(e => {
      if (!e.start || !(e.start.dateTime || e.start.date)) return false;
      const s = new Date(e.start.dateTime || e.start.date).getTime();
      return s >= rangeStart && s < rangeEnd;
    })
    .sort((a, b) => {
      const aS = new Date(a.start.dateTime || a.start.date).getTime();
      const bS = new Date(b.start.dateTime || b.start.date).getTime();
      return S.gcalRange === 'past' ? bS - aS : aS - bS;
    });

  if (!events.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    const emptyText = $('#meetingsEmptyText');
    if (emptyText) emptyText.textContent = S.gcalRange === 'past'
      ? 'No meetings in the past 7 days.'
      : S.gcalRange === 'week'
        ? 'No meetings in the next 7 days.'
        : 'No meetings today or tomorrow.';
    return;
  }
  list.classList.remove('hidden');
  empty.classList.add('hidden');

  const now = Date.now();
  const todayKey = new Date().toDateString();
  const yesterdayKey = new Date(Date.now() - 86400000).toDateString();
  const tomorrowKey = new Date(Date.now() + 86400000).toDateString();
  let currentSection = null;

  events.forEach(ev => {
    const startRaw = ev.start.dateTime || ev.start.date;
    const endRaw = (ev.end && (ev.end.dateTime || ev.end.date)) || startRaw;
    const startD = new Date(startRaw);
    const endD = new Date(endRaw);
    const dayKey = startD.toDateString();
    const sectionLabel = dayKey === todayKey
      ? 'TODAY'
      : dayKey === yesterdayKey
        ? 'YESTERDAY'
        : dayKey === tomorrowKey
          ? 'TOMORROW'
          : startD.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
    if (sectionLabel !== currentSection) {
      currentSection = sectionLabel;
      const h = el('div', 'meetings-section-header', sectionLabel);
      list.appendChild(h);
    }

    const isAllDay = !ev.start.dateTime;
    const isPast = endD.getTime() < now;
    const isActive = startD.getTime() <= now && endD.getTime() > now;
    const timeStr = isAllDay
      ? 'All day'
      : `${startD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${endD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const link = getMeetingLink(ev);
    const attendees = (ev.attendees || []).filter(a => !a.resource).length;
    const hasDetails = !!(ev.description || ev.location || ev.organizer || attendees > 0);
    const expanded = S.expandedMeetingIds.has(ev.id);

    const card = el('div', `meeting-card ${isPast && !isActive ? 'past' : ''} ${isActive ? 'active' : ''} ${hasDetails ? 'expandable' : ''}`);
    card.dataset.meetingId = ev.id;

    const gcalLink = ev.htmlLink || `https://calendar.google.com/calendar/u/0/r/eventedit/${btoa(ev.id)}`;
    const joinClass = isPast && !isActive ? 'meeting-join-past' : `meeting-join-${link ? link.type : 'meet'}`;
    const joinLabel = isPast && !isActive ? `Open ${link ? link.label : 'Meeting'}` : `Join ${link ? link.label : 'Meeting'}`;

    card.innerHTML = `
      <div class="meeting-time">
        ${escapeHTML(timeStr)}
        ${isActive ? '<span style="color:#22c55e;font-weight:800">· 🔴 LIVE</span>' : ''}
        ${isPast && !isActive ? '<span style="opacity:0.7">· ✓</span>' : ''}
      </div>
      <div class="meeting-title">${escapeHTML(ev.summary || '(no title)')}</div>
      ${attendees > 0 ? `<div class="meeting-attendees">👥 ${attendees} attendee${attendees > 1 ? 's' : ''}${ev.organizer && ev.organizer.displayName ? ' · organiser: ' + escapeHTML(ev.organizer.displayName) : ''}</div>` : ''}
      ${link ? `<a href="${escapeHTML(link.url)}" target="_blank" rel="noopener" class="meeting-join-btn ${joinClass}" data-nobubble>▶ ${escapeHTML(joinLabel)}</a>` : ''}
      ${expanded && hasDetails ? `
        <div class="meeting-details">
          ${ev.location ? `<div class="meeting-details-row"><span class="meeting-details-label">📍 Where</span><span class="meeting-details-val">${escapeHTML(ev.location).slice(0, 200)}</span></div>` : ''}
          ${ev.description ? `<div class="meeting-details-row"><span class="meeting-details-label">📝 Notes</span><span class="meeting-details-val">${sanitizeDescription(ev.description)}</span></div>` : ''}
          ${attendees > 0 && ev.attendees ? `<div class="meeting-details-row"><span class="meeting-details-label">👥 Who</span><span class="meeting-details-val">${escapeHTML(ev.attendees.filter(a=>!a.resource).map(a=>a.displayName||a.email).slice(0,8).join(', '))}${ev.attendees.length > 8 ? `, +${ev.attendees.length-8} more` : ''}</span></div>` : ''}
          <a href="${escapeHTML(gcalLink)}" target="_blank" rel="noopener" class="meeting-gcal-link" data-nobubble>📅 Open in Google Calendar</a>
        </div>
      ` : ''}
    `;

    if (hasDetails) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-nobubble]')) return;
        if (expanded) S.expandedMeetingIds.delete(ev.id);
        else S.expandedMeetingIds.add(ev.id);
        renderMeetings();
      });
    }
    list.appendChild(card);
  });
}

function sanitizeDescription(html) {
  // Gcal descriptions can contain HTML (links, line breaks). Convert to plain text with linkified URLs.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = (tmp.textContent || '').slice(0, 500);
  return escapeHTML(text).replace(/(https?:\/\/[^\s<>]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function updateGcalCountdown() {
  const wrap = $('#gcalCountdown');
  if (!wrap) return;
  if (S.gcalStatus !== 'ready') { wrap.classList.add('hidden'); return; }
  const now = Date.now();
  const upcoming = S.gcalMeetings
    .filter(e => e.start && e.start.dateTime)
    .map(e => ({ e, start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime || e.start.dateTime).getTime() }))
    .filter(m => m.end > now)
    .sort((a, b) => a.start - b.start);
  if (!upcoming.length) { wrap.classList.add('hidden'); return; }
  const m = upcoming[0];
  const mins = Math.round((m.start - now) / 60000);
  const active = m.start <= now && m.end > now;
  wrap.classList.remove('hidden');
  wrap.classList.toggle('gcal-countdown-active', active);
  if (active) {
    const endMin = Math.max(0, Math.round((m.end - now) / 60000));
    wrap.innerHTML = `🔴 LIVE · ${escapeHTML(m.e.summary || 'Meeting')} · ${endMin}m left`;
  } else if (mins <= 0) {
    wrap.innerHTML = `⏰ Starting now · ${escapeHTML(m.e.summary || 'Meeting')}`;
  } else if (mins < 60) {
    wrap.innerHTML = `⏰ Next: ${escapeHTML(m.e.summary || 'Meeting')} · in ${mins}m`;
  } else {
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    wrap.innerHTML = `⏰ Next: ${escapeHTML(m.e.summary || 'Meeting')} · in ${hrs}h ${rem}m`;
  }
}

function startGcalCountdownTicker() {
  if (S.gcalCountdownTimer) clearInterval(S.gcalCountdownTimer);
  S.gcalCountdownTimer = setInterval(updateGcalCountdown, 30_000);
}

async function initGcal() {
  // Clear any leftover OAuth state from the old implementation so it doesn't
  // linger in localStorage indefinitely on users who had connected before.
  localStorage.removeItem('gcalToken');
  localStorage.removeItem('gcalTokenExpiry');
  renderMeetings();
  refreshMeetings().catch(() => {});
  startGcalPolling();
  startGcalCountdownTicker();
}

/* ========== INIT ========== */
async function init() {
  wireEvents();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('service-worker.js'); } catch (e) { /* ignore */ }
  }

  if (!S.token) {
    $('#loadingScreen').classList.add('gone');
    $('#loadingScreen').style.display = 'none';
    if (S.name) $('#nameInput').value = S.name;
    $('#loginScreen').classList.remove('hidden');
    return;
  }

  try {
    const ok = await verifyToken(S.token);
    if (!ok) {
      localStorage.removeItem('ghToken');
      S.token = null;
      $('#loadingScreen').classList.add('gone');
      $('#loadingScreen').style.display = 'none';
      if (S.name) $('#nameInput').value = S.name;
      $('#loginScreen').classList.remove('hidden');
      return;
    }
    $('#app').classList.remove('hidden');
    await loadEverything();
    if (!S.name) {
      setTimeout(() => changeName(), 300);
    }
  } catch (e) {
    toast('Could not load: ' + e.message, 'error');
    $('#loadingScreen').classList.add('gone');
  }
}

init();
