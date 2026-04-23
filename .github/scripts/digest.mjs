/* Quest Log — daily morning digest.
 * Reads open quest issues, filters today+overdue, posts to Google Chat webhook.
 * Runs on schedule via morning-digest.yml. */

const [OWNER, REPO] = (process.env.REPO || '').split('/');
const TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK = process.env.GCHAT_WEBHOOK;
const GCAL_ICAL_URL = process.env.GCAL_ICAL_URL;
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

/* =================== iCal parsing =================== */
function parseICalDate(value, tzid) {
  if (!value) return null;
  const m = value.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z?)/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (hh === undefined) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: true };
  }
  if (z === 'Z') {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss || 0)), allDay: false };
  }
  // Floating or TZID-bound.
  // Heuristic: apply IST offset if TZID is missing or looks Indian; else try Intl resolver, else UTC.
  let offsetMin = 330;
  if (tzid) {
    const istTzids = ['Asia/Kolkata', 'Asia/Calcutta', 'IST', 'India Standard Time'];
    if (istTzids.includes(tzid)) {
      offsetMin = 330;
    } else {
      // Try resolving via Intl — compute offset for this zone at the given local time
      try {
        const guess = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss || 0));
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tzid,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(guess).reduce((a, p) => (a[p.type] = p.value, a), {});
        const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
        offsetMin = (guess.getTime() - localAsUtc) / 60000;
      } catch (e) {
        offsetMin = 0; // fallback: treat as UTC
      }
    }
  }
  const utcMs = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss || 0) - offsetMin * 60 * 1000;
  return { date: new Date(utcMs), allDay: false };
}

function unescapeICal(s) {
  return (s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function extractMeetLink(location, description) {
  const text = [location || '', description || ''].join(' ');
  const patterns = [
    { re: /https?:\/\/meet\.google\.com\/[^\s<>"']+/i, label: 'Meet' },
    { re: /https?:\/\/[^\s<>"']*zoom\.us\/[^\s<>"']+/i, label: 'Zoom' },
    { re: /https?:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/[^\s<>"']+/i, label: 'Teams' }
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return { url: m[0].replace(/[.,;)]+$/, ''), label: p.label };
  }
  return null;
}

function parseIcsEvents(ics) {
  const events = [];
  // Unfold line continuations (RFC 5545)
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0];
    const props = {};
    const tzids = {};
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^([A-Z-]+)((?:;[^:]+)?):(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const params = m[2] || '';
      const val = m[3];
      props[key] = val;
      const tzm = params.match(/TZID=([^;:]+)/i);
      if (tzm) tzids[key] = tzm[1];
    }
    if (!props.SUMMARY) continue;
    if (props.STATUS && props.STATUS.toUpperCase() === 'CANCELLED') continue;
    const startParsed = parseICalDate(props.DTSTART, tzids.DTSTART);
    const endParsed = parseICalDate(props.DTEND, tzids.DTEND);
    if (!startParsed) continue;
    events.push({
      uid: props.UID,
      summary: unescapeICal(props.SUMMARY),
      location: unescapeICal(props.LOCATION),
      description: unescapeICal(props.DESCRIPTION),
      start: startParsed.date,
      end: endParsed ? endParsed.date : startParsed.date,
      allDay: startParsed.allDay
    });
  }
  return events;
}

async function fetchTodayMeetings() {
  if (!GCAL_ICAL_URL) {
    console.log('[meetings] GCAL_ICAL_URL not set — skipping meetings section');
    return null;
  }
  try {
    console.log('[meetings] Fetching iCal feed…');
    const res = await fetch(GCAL_ICAL_URL);
    console.log('[meetings] iCal HTTP status:', res.status);
    if (!res.ok) { console.warn('[meetings] iCal non-OK response'); return null; }
    const text = await res.text();
    console.log('[meetings] iCal body length:', text.length, 'chars');
    const events = parseIcsEvents(text);
    console.log('[meetings] Parsed events total:', events.length);
    const todayKey = istParts(new Date()).dateKey;
    console.log('[meetings] Today (IST):', todayKey);
    const todayEvents = events
      .filter(e => !e.allDay && istParts(e.start).dateKey === todayKey)
      .sort((a, b) => a.start - b.start);
    console.log('[meetings] Today events found:', todayEvents.length);
    if (todayEvents.length === 0 && events.length > 0) {
      // Log a sample of what dates we did find, to help diagnose
      const sample = events.slice(0, 5).map(e => ({
        summary: e.summary,
        start: e.start.toISOString(),
        istDate: istParts(e.start).dateKey
      }));
      console.log('[meetings] Sample parsed events (first 5):', JSON.stringify(sample, null, 2));
    }
    return todayEvents;
  } catch (e) {
    console.warn('[meetings] fetch/parse failed:', e.message);
    return null;
  }
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
  const meetings = await fetchTodayMeetings();

  let msg = `🌅 *Good morning, Adventurer!*  \`${dayLabel(now)}\`\n`;
  if (streak > 0) msg += `🔥 Current streak: *${streak} day${streak > 1 ? 's' : ''}*\n`;
  msg += '\n';

  const hasMeetings = Array.isArray(meetings) && meetings.length > 0;
  const hasAnything = overdue.length || today.length || hasMeetings;

  if (!hasAnything) {
    msg += `🌤️ *No quests or meetings today.*\nA well-earned rest awaits, hero. 🛡️\n\nScribe a new quest when you're ready. ⚔️`;
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
    if (hasMeetings) {
      msg += `🎥 *MEETINGS TODAY (${meetings.length})*\n`;
      for (const m of meetings) {
        const hhmm = istParts(m.start).hhmm;
        const endHhmm = istParts(m.end).hhmm;
        const link = extractMeetLink(m.location, m.description);
        const linkStr = link ? ` — <${link.url}|▶ Join ${link.label}>` : '';
        const title = (m.summary || '(no title)').slice(0, 80);
        msg += `• \`${hhmm}–${endHhmm}\` *${title}*${linkStr}\n`;
      }
      msg += '\n';
    }
    msg += `_Conquer today and earn your XP! ⚔️_`;
  }

  if (GCAL_ICAL_URL && !hasMeetings) {
    // Keep user informed: iCal was checked but found nothing
    // (no extra message — avoid clutter)
  } else if (!GCAL_ICAL_URL) {
    // Gentle nudge the first few digests
    // (commented out — don't want to nag)
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
