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
  activeTab: 'today',
  activeTagFilter: null,
  editingTaskId: null,
  selectedTags: new Set(),
  soundOn: localStorage.getItem('soundOn') !== 'false',
  deferredInstall: null,
  prevLevel: 1,
  prevBadges: new Set()
};

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
function serializeTask({ deadline, recurring, notes, createdAt }) {
  const meta = `${CONFIG.metaMarkerStart}\nversion: 1\ndeadline: ${deadline}\nrecurring: ${recurring || 'none'}\ncreatedAt: ${createdAt}\n${CONFIG.metaMarkerEnd}`;
  return `${meta}\n\n${notes || ''}`.trim();
}

function parseTask(issue) {
  const body = issue.body || '';
  const metaMatch = body.match(/<!--\s*quest-meta([\s\S]*?)-->/);
  const meta = {};
  if (metaMatch) {
    metaMatch[1].split('\n').forEach(line => {
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
  const active = tasks.filter(t => !(t.issue?.labels || []).some(l => l.name === 'deleted'));
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

  card.innerHTML = `
    ${checkHTML}
    <div class="task-body">
      <div class="task-title">${escapeHTML(task.title)}</div>
      <div class="task-meta">
        <span class="task-deadline ${dl.cls}">${dl.text}</span>
        ${tagsHTML}
        ${recurringHTML}
      </div>
      ${task.notes ? `<div class="task-notes">${escapeHTML(task.notes)}</div>` : ''}
    </div>
    <div class="task-actions">
      <button class="task-action-btn edit-btn" title="Edit">✏️</button>
      <button class="task-action-btn del-btn" title="Delete">🗑️</button>
    </div>
  `;

  card.querySelector('.task-check').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (task.state === 'closed') reopenTask(task);
    else closeTaskFlow(task, ev);
  });
  card.querySelector('.edit-btn').addEventListener('click', (ev) => { ev.stopPropagation(); openTaskModal(task); });
  card.querySelector('.del-btn').addEventListener('click', (ev) => { ev.stopPropagation(); deleteTaskFlow(task, card); });

  const notesEl = card.querySelector('.task-notes');
  if (notesEl) notesEl.addEventListener('click', () => notesEl.classList.toggle('expanded'));

  return card;
}

/* ========== UI: RENDER TABS ========== */
function renderAll() {
  renderHero();
  renderToday();
  renderUpcoming();
  renderAllOpen();
  renderDone();
  renderBadgesGrid();
}

function renderToday() {
  const now = Date.now();
  const todayStr = new Date().toDateString();
  const overdue = S.tasks.filter(t => t.state === 'open' && t.deadline && new Date(t.deadline).getTime() < now && new Date(t.deadline).toDateString() !== todayStr);
  const today = S.tasks.filter(t => t.state === 'open' && t.deadline && new Date(t.deadline).toDateString() === todayStr);
  const overdueList = $('#overdueList'); overdueList.innerHTML = '';
  const todayList = $('#todayList'); todayList.innerHTML = '';
  overdue.sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).forEach(t => overdueList.appendChild(renderTaskCard(t)));
  today.sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).forEach(t => todayList.appendChild(renderTaskCard(t)));
  $('#todayEmpty').classList.toggle('hidden', overdue.length + today.length > 0);
}

function renderUpcoming() {
  const now = Date.now();
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const in7d = now + 7 * 86400000;
  const items = S.tasks.filter(t =>
    t.state === 'open' && t.deadline &&
    new Date(t.deadline).getTime() > todayEnd.getTime() &&
    new Date(t.deadline).getTime() <= in7d
  ).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const list = $('#upcomingList'); list.innerHTML = '';
  items.forEach(t => list.appendChild(renderTaskCard(t)));
  $('#upcomingEmpty').classList.toggle('hidden', items.length > 0);
}

function renderAllOpen() {
  renderTagFilter();
  const list = $('#allList'); list.innerHTML = '';
  let items = S.tasks.filter(t => t.state === 'open');
  if (S.activeTagFilter) items = items.filter(t => t.tags.includes(S.activeTagFilter));
  items.sort((a, b) => {
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return new Date(a.deadline) - new Date(b.deadline);
  });
  items.forEach(t => list.appendChild(renderTaskCard(t)));
  if (!items.length) list.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div class="empty-title">No open quests</div></div>';
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
  const tagsInUse = new Set(S.tasks.filter(t => t.state === 'open').flatMap(t => t.tags));
  const allChip = el('div', `tag-filter-chip ${!S.activeTagFilter ? 'active' : ''}`, 'All');
  allChip.addEventListener('click', () => { S.activeTagFilter = null; renderAllOpen(); });
  wrap.appendChild(allChip);
  [...tagsInUse].sort().forEach(tname => {
    const chip = el('div', `tag-filter-chip ${S.activeTagFilter === tname ? 'active' : ''}`, escapeHTML(tname));
    const lbl = S.labels.find(l => l.name === tname);
    if (lbl && S.activeTagFilter === tname) chip.style.background = `#${lbl.color}55`;
    chip.addEventListener('click', () => { S.activeTagFilter = tname; renderAllOpen(); });
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
function openTaskModal(task = null) {
  S.editingTaskId = task ? task.id : null;
  S.selectedTags = new Set(task ? task.tags : []);
  $('#taskModalTitle').textContent = task ? '✏️ Edit Quest' : '⚔️ New Quest';
  $('#taskTitle').value = task ? task.title : '';
  $('#taskRecurring').value = task ? task.recurring || 'none' : 'none';
  $('#taskNotes').value = task ? task.notes : '';
  $('#taskSubmitBtn .btn-label').textContent = task ? '💾 Save Changes' : '⚔️ Scribe Quest';

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
    const data = {
      title,
      deadline,
      recurring: $('#taskRecurring').value,
      notes: $('#taskNotes').value.trim(),
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
async function closeTaskFlow(task, ev) {
  const card = ev.target.closest('.task');
  if (card) card.classList.add('closing');
  const rect = ev.target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const xpReward = computeCloseXP({ ...task, closedAt: new Date().toISOString() });
  floatXPAt(`+${xpReward} XP`, cx, cy);
  burstConfetti(cx / window.innerWidth, cy / window.innerHeight);
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
  }
}

async function reopenTask(task) {
  try {
    const reopened = await reopenTaskApi(task.id);
    const idx = S.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0 && reopened) S.tasks[idx] = parseTask(reopened);
    S.stats = computeStats(S.tasks);
    renderAll();
    refresh().catch(() => {});
  } catch (e) { toast('Could not reopen: ' + e.message, 'error'); }
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
  S.tasks = issues
    .map(parseTask)
    .filter(t => !(t.issue.labels || []).some(l => l.name === 'deleted'));

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
}

async function loadEverything() {
  $('#loadingText').textContent = 'Loading labels…';
  await loadLabels();
  $('#loadingText').textContent = 'Setting up labels…';
  await ensureBaseLabels();
  $('#loadingText').textContent = 'Loading quests…';
  await refresh();
  $('#loadingScreen').classList.add('gone');
  setTimeout(() => $('#loadingScreen').style.display = 'none', 400);
}

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

  $('#refreshBtn').addEventListener('click', async () => { closeModals(); await refresh(); toast('Refreshed ✓', 'success'); });
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

  $$('[data-close-modal]').forEach(b => b.addEventListener('click', closeModals));
  $$('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
  });
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
