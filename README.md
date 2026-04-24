# 🎮 Quest Log — Gamified Task Management

Your life, gamified. A mobile-first RPG task manager that runs on GitHub Pages, stores tasks as GitHub Issues, and sends a daily morning digest to Google Chat.

**Live app:** https://hathi-jigar.github.io/task-management/

## Features

- 🎯 **Tasks as Quests** — each task is a GitHub Issue in this repo
- ⚔️ **XP & Levels** — earn XP for adding and closing quests, level up with a full-screen celebration
- ❤️ **HP bar** — overdue quests drain your HP; close them to heal
- 🔥 **Streaks** — consecutive days of closing ≥1 quest
- 🏆 **20 Badges** — unlock achievements for various milestones
- 🏷️ **Tags** — create/edit/delete tags (stored as GitHub Labels)
- 🔁 **Recurring tasks** — daily / weekly / monthly; auto-regenerates on close
- 🌅 **Daily 8 AM digest** — Google Chat message listing today's quests + overdue + delegated
- 👥 **Delegate quests** — assign a quest to someone else (free-text name). Lives on its own **Delegated** tab, never mixed with your own. Tracking-only — no XP gain/loss for delegated work.
- 📅 **Meetings panel** — reads `meetings.json` (refreshed every 15 min by GitHub Action from the GCAL_ICAL_URL iCal feed). No OAuth, no tokens, no 1-hour logout loop.
- 📲 **PWA** — install to home screen on iOS and Android
- 🎊 **Playful UX** — confetti on close, floating XP pops, level-up modal, sound fx

## Initial setup (one-time)

### 1. Enable GitHub Pages
- Go to this repo → **Settings → Pages**
- Under "Build and deployment", select **Source: Deploy from a branch**
- Choose **Branch: `main`, folder: `/ (root)`**
- Click **Save**. Your app will be at `https://<username>.github.io/task-management/` within ~1 minute.

### 2. Add the Google Chat webhook secret
- Go to **Settings → Secrets and variables → Actions → New repository secret**
- Name: `GCHAT_WEBHOOK`
- Value: your Google Chat incoming webhook URL
- Save.

### 3. Create a GitHub Personal Access Token
- Visit https://github.com/settings/tokens/new?scopes=repo&description=Quest%20Log
- Scope: `repo` only
- Expiration: No expiration (or your preference)
- Generate and copy the token (`ghp_...`)

### 4. Open the app
- Visit `https://<username>.github.io/task-management/` on phone or desktop
- Paste your PAT → **Begin Adventure**
- Token is stored only in browser localStorage — never leaves your device.

### 5. Install to home screen (mobile)
- iOS Safari: Share → Add to Home Screen
- Android Chrome: Menu → Install app

## How it works

### Data model
- Each task is a GitHub Issue labeled `quest`.
- Task metadata (deadline, recurring, notes) is stored in the issue body inside an HTML comment.
- Tags are GitHub Labels.
- Closed issue = completed task.
- Recurring: when closed, the app auto-creates the next instance with deadline pushed forward.

### Gamification engine
All XP/Level/HP/Streak/Badges are **computed live** from the issue history — no separate state to sync.

**XP rewards:**
- +5 XP per quest added
- +10 base XP for closing (+10 more if >24h early, +5 if same-day on time, −1 to −5 if overdue)
- +5 speedrunner bonus (closed within 1 hour of creation)

**Level curve:**
Level `N` requires cumulative `100 × N × (N−1) / 2` XP. So Level 2 @ 100 XP, Level 3 @ 300, Level 5 @ 1000.

**HP:**
Starts at 100. Each overdue task drains `2 × days overdue` HP (capped 30 per task). Close overdue tasks to recover.

### Morning digest
- GitHub Action runs daily at **02:30 UTC (08:00 IST)**.
- Fetches open issues, filters by deadline, posts to `GCHAT_WEBHOOK`.
- Change the cron in [`.github/workflows/morning-digest.yml`](.github/workflows/morning-digest.yml) to shift the time.

### Running the digest manually
```bash
gh workflow run morning-digest.yml
```
Or trigger from **Actions tab → Morning Quest Digest → Run workflow**.

## Repo layout
```
├── index.html              # App shell
├── style.css               # All styles
├── app.js                  # All logic (GH API + gamification + UI)
├── manifest.json           # PWA config
├── service-worker.js       # Offline cache
├── icons/icon.svg          # App icon
├── meetings.json           # Auto-refreshed (±7 day window)
└── .github/
    ├── workflows/
    │   ├── morning-digest.yml      # Daily 8 AM cron → Google Chat
    │   └── refresh-meetings.yml    # Every 15 min → writes meetings.json
    └── scripts/
        ├── digest.mjs              # Digest: Mine / Delegated / Meetings
        └── refresh-meetings.mjs    # iCal feed → meetings.json
```

## Troubleshooting
- **Digest not sending**: Check Actions tab for errors. Confirm `GCHAT_WEBHOOK` secret is set and the URL hasn't been revoked.
- **Can't log in**: PAT needs `repo` scope. Make sure you generated a classic token (not fine-grained).
- **Icons look generic on iOS**: iOS older than 16 doesn't support SVG apple-touch-icon — you may see a default home screen icon.

## License
MIT
