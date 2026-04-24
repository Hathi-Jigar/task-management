/* Fetch the GCAL_ICAL_URL feed, expand recurring events across a ±7 day window
 * around today (IST), and write a meetings.json file the web app can fetch
 * same-origin. Replaces the browser-side Google OAuth flow, which was losing
 * its token every ~1 hour (implicit flow issues no refresh token, silent
 * re-auth is blocked by most browsers' third-party cookie policies). */

import ical from 'node-ical';
import fs from 'node:fs';
import path from 'node:path';

const GCAL_ICAL_URL = process.env.GCAL_ICAL_URL;
const OUT_PATH = process.env.OUT_PATH || 'meetings.json';
const TZ = 'Asia/Kolkata';

if (!GCAL_ICAL_URL) {
  console.error('GCAL_ICAL_URL not set — cannot refresh meetings.');
  process.exit(1);
}

function istDateKey(d) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function extractMeetLink(location, description) {
  const text = [location || '', description || ''].join(' ');
  const patterns = [
    { re: /https?:\/\/meet\.google\.com\/[^\s<>"']+/i, type: 'meet', label: 'Meet' },
    { re: /https?:\/\/[^\s<>"']*zoom\.us\/[^\s<>"']+/i, type: 'zoom', label: 'Zoom' },
    { re: /https?:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\/[^\s<>"']+/i, type: 'teams', label: 'Teams' }
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return { url: m[0].replace(/[.,;)]+$/, ''), type: p.type, label: p.label };
  }
  return null;
}

function shapeInstance(ev, start, end, overrideSource) {
  const src = overrideSource || ev;
  const summary = src.summary || ev.summary || '';
  const location = src.location || ev.location || '';
  const description = stripHtml(src.description || ev.description || '');
  const link = extractMeetLink(location, description);
  const attendees = (ev.attendee ? (Array.isArray(ev.attendee) ? ev.attendee : [ev.attendee]) : [])
    .map(a => {
      // node-ical gives attendees either as strings or objects with `params`
      if (typeof a === 'string') return { email: a.replace(/^mailto:/i, ''), displayName: '' };
      const p = a.params || {};
      return {
        email: (a.val || '').replace(/^mailto:/i, ''),
        displayName: p.CN || '',
        resource: /RESOURCE/i.test(p.CUTYPE || '')
      };
    })
    .filter(a => a.email || a.displayName);
  const organizer = ev.organizer
    ? {
        displayName: (ev.organizer.params && ev.organizer.params.CN) || '',
        email: ((ev.organizer.val || '') + '').replace(/^mailto:/i, '')
      }
    : null;
  return {
    id: `${ev.uid || summary}|${start.toISOString()}`,
    summary,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    location,
    description,
    hangoutLink: link && link.type === 'meet' ? link.url : null,
    meetLink: link ? { url: link.url, type: link.type, label: link.label } : null,
    htmlLink: ev.url || null,
    attendees,
    organizer,
    status: 'confirmed'
  };
}

async function main() {
  console.log('[refresh-meetings] Fetching iCal feed…');
  const events = await ical.async.fromURL(GCAL_ICAL_URL);
  const vevents = Object.values(events).filter(e => e.type === 'VEVENT');
  console.log('[refresh-meetings] VEVENTs loaded:', vevents.length);

  // Generate a 15-day window (past 7 days → next 7 days) so the app can
  // show all 3 range presets (past / today-tomorrow / next week) without
  // refetching. Everything is computed in IST since the app is IST-primary.
  const now = new Date();
  const todayKey = istDateKey(now);
  const istStart = new Date(`${todayKey}T00:00:00+05:30`);
  const windowStart = new Date(istStart.getTime() - 7 * 86400000);
  const windowEnd = new Date(istStart.getTime() + 8 * 86400000);

  const instances = [];

  for (const ev of vevents) {
    if (ev.status === 'CANCELLED') continue;
    if (!ev.start) continue;

    const durationMs = (ev.end && ev.start) ? (ev.end.getTime() - ev.start.getTime()) : 3600000;

    const exdates = new Set();
    if (ev.exdate) {
      for (const k in ev.exdate) {
        const d = ev.exdate[k];
        if (d instanceof Date) exdates.add(d.toISOString().slice(0, 16));
      }
    }
    const overrides = {};
    if (ev.recurrences) {
      for (const k in ev.recurrences) {
        const origKey = new Date(k).toISOString().slice(0, 16);
        overrides[origKey] = ev.recurrences[k];
      }
    }

    if (ev.rrule) {
      const searchStart = new Date(windowStart.getTime() - 2 * 86400000);
      const searchEnd = new Date(windowEnd.getTime() + 2 * 86400000);
      let dates;
      try {
        dates = ev.rrule.between(searchStart, searchEnd, true);
      } catch (e) {
        console.warn('[refresh-meetings] rrule expand failed for', ev.summary, e.message);
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
          if (ovStart >= windowStart && ovStart < windowEnd) {
            instances.push(shapeInstance(ev, ovStart, ovEnd, ov));
          }
          continue;
        }
        if (date >= windowStart && date < windowEnd) {
          instances.push(shapeInstance(ev, date, new Date(date.getTime() + durationMs)));
        }
      }
    } else if (ev.start >= windowStart && ev.start < windowEnd) {
      instances.push(shapeInstance(ev, ev.start, ev.end || new Date(ev.start.getTime() + durationMs)));
    }
  }

  // De-dupe on id, sort by start
  const seen = new Set();
  const unique = [];
  for (const m of instances) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }
  unique.sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));

  const payload = {
    generatedAt: new Date().toISOString(),
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    events: unique
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  // Pretty-print so git diffs stay readable + the file is sub-100KB.
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[refresh-meetings] Wrote ${unique.length} events → ${OUT_PATH}`);
}

main().catch(e => { console.error('refresh-meetings failed:', e); process.exit(1); });
