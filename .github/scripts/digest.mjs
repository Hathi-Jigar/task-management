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

/* =================== iCal (via node-ical) =================== */
import ical from 'node-ical';

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

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

async function fetchTodayMeetings() {
  if (!GCAL_ICAL_URL) {
    console.log('[meetings] GCAL_ICAL_URL not set — skipping meetings section');
    return null;
  }
  try {
    console.log('[meetings] Fetching iCal feed…');
    const events = await ical.async.fromURL(GCAL_ICAL_URL);
    const vevents = Object.values(events).filter(e => e.type === 'VEVENT');
    console.log('[meetings] VEVENTs loaded:', vevents.length);

    // Today boundaries in IST (00:00 IST = 18:30 prev-day UTC)
    const todayKey = istParts(new Date()).dateKey; // e.g., "2026-04-23"
    const istStart = new Date(`${todayKey}T00:00:00+05:30`);
    const istEnd = new Date(istStart.getTime() + 86400000);
    console.log('[meetings] IST day window:', istStart.toISOString(), '→', istEnd.toISOString());

    const instances = [];

    for (const ev of vevents) {
      if (ev.status === 'CANCELLED') continue;
      if (!ev.start) continue;

      const durationMs = (ev.end && ev.start) ? (ev.end.getTime() - ev.start.getTime()) : 3600000;

      // Gather exceptions (modified single instances) and EXDATEs
      const exdates = new Set();
      if (ev.exdate) {
        for (const k in ev.exdate) {
          const d = ev.exdate[k];
          if (d instanceof Date) exdates.add(d.toISOString().slice(0, 10) + 'T' + d.toISOString().slice(11, 16));
        }
      }
      // Recurrence overrides — rescheduled single instances
      const overrides = {};
      if (ev.recurrences) {
        for (const k in ev.recurrences) {
          const r = ev.recurrences[k];
          const origKey = new Date(k).toISOString().slice(0, 16);
          overrides[origKey] = r;
        }
      }

      if (ev.rrule) {
        // Expand recurrences within today's IST window
        // Pad the search window by ±2 days to catch cross-TZ edge cases
        const searchStart = new Date(istStart.getTime() - 86400000 * 2);
        const searchEnd = new Date(istEnd.getTime() + 86400000 * 2);
        let dates;
        try {
          dates = ev.rrule.between(searchStart, searchEnd, true);
        } catch (e) {
          console.warn('[meetings] rrule expand failed for', ev.summary, e.message);
          dates = [];
        }
        for (const date of dates) {
          const origKey = date.toISOString().slice(0, 16);
          if (exdates.has(origKey)) continue;
          if (overrides[origKey]) {
            const ov = overrides[origKey];
            if (ov.status === 'CANCELLED') continue;
            const ovStart = ov.start;
            const ovEnd = ov.end || new Date(ovStart.getTime() + durationMs);
            if (ovStart >= istStart && ovStart < istEnd) {
              instances.push({
                summary: ov.summary || ev.summary,
                location: ov.location || ev.location,
                description: stripHtml(ov.description || ev.description),
                start: ovStart, end: ovEnd
              });
            }
            continue;
          }
          if (date >= istStart && date < istEnd) {
            instances.push({
              summary: ev.summary,
              location: ev.location,
              description: stripHtml(ev.description),
              start: date,
              end: new Date(date.getTime() + durationMs)
            });
          }
        }
      } else if (ev.start >= istStart && ev.start < istEnd) {
        // Non-recurring
        instances.push({
          summary: ev.summary,
          location: ev.location,
          description: stripHtml(ev.description),
          start: ev.start,
          end: ev.end || new Date(ev.start.getTime() + durationMs)
        });
      }
    }

    // De-dupe (recurrence overrides can double-count if master is also in range)
    const seen = new Set();
    const unique = [];
    for (const m of instances) {
      const key = m.start.toISOString() + '|' + (m.summary || '');
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(m);
    }
    unique.sort((a, b) => a.start - b.start);
    console.log('[meetings] Today instances:', unique.length);
    return unique;
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
