/* Quest Log — daily morning digest.
 * Reads open quest issues, filters today+overdue, posts to Google Chat webhook.
 * Runs on schedule via morning-digest.yml. */

const [OWNER, REPO] = (process.env.REPO || '').split('/');
const TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK = process.env.GCHAT_WEBHOOK;
const TZ = 'Asia/Kolkata';

if (!WEBHOOK) { console.error('GCHAT_WEBHOOK secret not set — add it in repo settings.'); process.exit(1); }
if (!TOKEN) { console.error('GITHUB_TOKEN not set.'); process.exit(1); }
if (!OWNER || !REPO) { console.error('REPO env var missing.'); process.exit(1); }

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      'Authorization': `token ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) throw new Error(`GH ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllQuests() {
  const issues = [];
  let page = 1;
  while (true) {
    const batch = await gh(`/repos/${OWNER}/${REPO}/issues?state=open&per_page=100&page=${page}&labels=quest`);
    if (!batch.length) break;
    issues.push(...batch.filter(i => !i.pull_request));
    if (batch.length < 100) break;
    page++;
  }
  return issues;
}

function parseDeadline(body) {
  if (!body) return null;
  const m = body.match(/deadline:\s*(.+?)\s*$/m);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d.getTime()) ? null : d;
}

function istParts(d) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`
  };
}

function daysBetween(aDate, bDate) {
  return Math.floor((aDate.getTime() - bDate.getTime()) / 86400000);
}

function dayLabel(d) {
  return d.toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' });
}

function countClosedToday(issues) {
  // Optional future enhancement
  return 0;
}

async function computeStreak() {
  // Fetch closed quests in the last 120 days to compute streak
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const closed = [];
  let page = 1;
  while (true) {
    const batch = await gh(`/repos/${OWNER}/${REPO}/issues?state=closed&per_page=100&page=${page}&labels=quest&since=${since}`);
    if (!batch.length) break;
    closed.push(...batch.filter(i => !i.pull_request && i.closed_at));
    if (batch.length < 100) break;
    page++;
  }
  const byDay = new Set(closed.map(i => istParts(new Date(i.closed_at)).dateKey));
  const now = new Date();
  let streak = 0;
  let d = new Date(now);
  while (true) {
    const key = istParts(d).dateKey;
    if (!byDay.has(key)) break;
    streak++;
    d.setDate(d.getDate() - 1);
    if (streak > 200) break;
  }
  return streak;
}

function getTags(issue) {
  return (issue.labels || [])
    .filter(l => l.name !== 'quest' && !l.name.startsWith('recurring:') && l.name !== 'deleted')
    .map(l => l.name);
}

async function main() {
  const now = new Date();
  const todayKey = istParts(now).dateKey;

  const issues = await fetchAllQuests();

  const enriched = issues
    .map(i => ({
      issue: i,
      deadline: parseDeadline(i.body || '')
    }))
    .filter(e => e.deadline);

  const overdue = [];
  const today = [];

  for (const e of enriched) {
    const dlKey = istParts(e.deadline).dateKey;
    if (dlKey < todayKey) overdue.push(e);
    else if (dlKey === todayKey) today.push(e);
  }

  overdue.sort((a, b) => a.deadline - b.deadline);
  today.sort((a, b) => a.deadline - b.deadline);

  const streak = await computeStreak().catch(() => 0);

  let msg = `🌅 *Good morning, Adventurer!*  \`${dayLabel(now)}\`\n`;
  if (streak > 0) msg += `🔥 Current streak: *${streak} day${streak > 1 ? 's' : ''}*\n`;
  msg += '\n';

  if (!overdue.length && !today.length) {
    msg += `🌤️ *No quests scheduled for today.*\nA well-earned rest awaits, hero. 🛡️\n\nScribe a new quest when you're ready. ⚔️`;
  } else {
    if (overdue.length) {
      msg += `⚠️ *OVERDUE (${overdue.length})*\n`;
      for (const e of overdue) {
        const days = daysBetween(now, e.deadline);
        const tags = getTags(e.issue);
        const tagStr = tags.length ? ` _[${tags.join(', ')}]_` : '';
        msg += `• <${e.issue.html_url}|${e.issue.title}> — *${days}d overdue*${tagStr}\n`;
      }
      msg += '\n';
    }
    if (today.length) {
      msg += `🎯 *DUE TODAY (${today.length})*\n`;
      for (const e of today) {
        const hhmm = istParts(e.deadline).hhmm;
        const tags = getTags(e.issue);
        const tagStr = tags.length ? ` _[${tags.join(', ')}]_` : '';
        msg += `• <${e.issue.html_url}|${e.issue.title}> — \`${hhmm}\`${tagStr}\n`;
      }
      msg += '\n';
    }
    msg += `_Conquer today and earn your XP! ⚔️_`;
  }

  const appUrl = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
  msg += `\n\n🎮 <${appUrl}|Open Quest Log>`;

  console.log('Message preview:\n', msg);

  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text: msg })
  });
  const respText = await res.text();
  if (!res.ok) throw new Error(`Chat webhook ${res.status}: ${respText}`);
  console.log('Digest sent OK.');
}

main().catch(e => { console.error('Digest failed:', e); process.exit(1); });
