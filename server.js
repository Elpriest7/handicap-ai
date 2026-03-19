// ============================================================
// HandicapAI — Backend Server
// Stack: Node.js + Express + SQLite + node-cron
// ============================================================

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve frontend

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  ODDS_API_KEY: process.env.ODDS_API_KEY || 'YOUR_ODDS_API_KEY',   // https://the-odds-api.com (free tier)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_KEY',
  MIN_PROBABILITY: 70,       // only show picks 70%+
  BANKER_THRESHOLD: 82,      // 82%+ = banker
  DAILY_FETCH_HOUR: '07:00', // fetch at 7am daily
  DB_PATH: './handicap.db',
  PORT: 3000,

  // Leagues supported (The Odds API keys)
  LEAGUES: [
    { key: 'soccer_epl',          name: 'Premier League',  flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { key: 'soccer_spain_la_liga',name: 'La Liga',         flag: '🇪🇸' },
    { key: 'soccer_italy_serie_a',name: 'Serie A',         flag: '🇮🇹' },
    { key: 'soccer_germany_bundesliga', name: 'Bundesliga', flag: '🇩🇪' },
    { key: 'soccer_france_ligue_one',   name: 'Ligue 1',   flag: '🇫🇷' },
  ],

  // Bookmakers to include (Odds API keys)
  BOOKMAKERS: ['bet9ja', 'onexbet', 'betway'],
};

// ── DATABASE SETUP ───────────────────────────────────────────
const db = new Database(CONFIG.DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS predictions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id    TEXT UNIQUE,
    date        TEXT,
    league      TEXT,
    league_flag TEXT,
    home_team   TEXT,
    away_team   TEXT,
    favorite    TEXT,
    handicap    TEXT,
    handicap_label TEXT,
    win_condition TEXT,
    probability INTEGER,
    is_banker   INTEGER DEFAULT 0,
    bookmaker   TEXT,
    odds        REAL,
    status      TEXT DEFAULT 'pending',
    home_score  INTEGER,
    away_score  INTEGER,
    home_form   TEXT,
    away_form   TEXT,
    h2h_summary TEXT,
    insights    TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT UNIQUE,
    total     INTEGER DEFAULT 0,
    wins      INTEGER DEFAULT 0,
    losses    INTEGER DEFAULT 0,
    bankers   INTEGER DEFAULT 0,
    banker_wins INTEGER DEFAULT 0,
    avg_prob  REAL DEFAULT 0
  );
`);

// ── ODDS FETCHER ─────────────────────────────────────────────
async function fetchOddsForLeague(leagueKey) {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${leagueKey}/odds/` +
      `?apiKey=${CONFIG.ODDS_API_KEY}&regions=eu&markets=h2h,spreads&oddsFormat=decimal` +
      `&bookmakers=${CONFIG.BOOKMAKERS.join(',')}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Odds API error: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[OddsAPI] ${leagueKey}:`, err.message);
    return [];
  }
}

// ── AI HANDICAP ANALYZER ─────────────────────────────────────
async function analyzeMatchWithAI(match, leagueMeta) {
  const prompt = `You are an expert football handicap analyst specializing in European Handicap (H1, H2, H3) betting.

Match: ${match.home_team} vs ${match.away_team}
League: ${leagueMeta.name}
Date: ${match.commence_time}
Available odds: ${JSON.stringify(match.bookmakers?.slice(0,2) || [])}

Your task:
1. Identify the clear FAVORITE between the two teams
2. Select the most probable European Handicap: H1 (win by 1+), H2 (win by 2+), or H3 (win by 3+)
3. Assign a probability % (only return if 70%+, else return null)
4. Provide 3 short insight tags (max 4 words each)
5. Determine if this is a BANKER (probability 82%+)

Consider: recent form, head-to-head, home advantage, league position, goal-scoring trends.

Respond ONLY with valid JSON, no markdown:
{
  "favorite": "team name exactly as given",
  "handicap": "H1" or "H2" or "H3",
  "win_condition": "Win by 1+ goals" or "Win by 2+ goals" or "Win by 3+ goals",
  "probability": number (70-99) or null,
  "is_banker": true or false,
  "home_form": "WWDLW",
  "away_form": "LWLLD",
  "h2h_summary": "short string e.g. H2H 6W-2D-2L",
  "insights": ["tag1", "tag2", "tag3"],
  "bookmaker": "bet9ja or 1xbet or betway",
  "odds": number
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[AI]', match.home_team, 'vs', match.away_team, ':', err.message);
    return null;
  }
}

// ── DAILY FETCH & ANALYZE ────────────────────────────────────
async function runDailyUpdate() {
  console.log(`[CRON] Starting daily update at ${new Date().toISOString()}`);
  const today = new Date().toISOString().split('T')[0];
  let totalInserted = 0;

  for (const league of CONFIG.LEAGUES) {
    console.log(`[FETCH] ${league.name}...`);
    const matches = await fetchOddsForLeague(league.key);

    for (const match of matches) {
      // Only today's and tomorrow's matches
      const matchDate = new Date(match.commence_time).toISOString().split('T')[0];
      if (matchDate > new Date(Date.now() + 86400000*2).toISOString().split('T')[0]) continue;

      // Skip if already in DB
      const existing = db.prepare('SELECT id FROM predictions WHERE match_id = ?').get(match.id);
      if (existing) continue;

      // AI analysis
      const analysis = await analyzeMatchWithAI(match, league);
      if (!analysis || !analysis.probability || analysis.probability < CONFIG.MIN_PROBABILITY) continue;

      const matchTime = new Date(match.commence_time);
      const timeStr = matchTime.toTimeString().slice(0,5);

      db.prepare(`
        INSERT OR IGNORE INTO predictions
        (match_id, date, league, league_flag, home_team, away_team, favorite,
         handicap, handicap_label, win_condition, probability, is_banker,
         bookmaker, odds, home_form, away_form, h2h_summary, insights, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        match.id, matchDate, league.name, league.flag,
        match.home_team, match.away_team,
        analysis.favorite,
        analysis.handicap,
        `${analysis.favorite} ${analysis.handicap}`,
        analysis.win_condition,
        analysis.probability,
        analysis.is_banker ? 1 : 0,
        analysis.bookmaker || 'bet9ja',
        analysis.odds || 1.75,
        analysis.home_form || 'WWDLW',
        analysis.away_form || 'LWLLD',
        analysis.h2h_summary || '',
        JSON.stringify(analysis.insights || []),
        'pending'
      );
      totalInserted++;
      console.log(`  ✓ ${match.home_team} vs ${match.away_team} → ${analysis.favorite} ${analysis.handicap} (${analysis.probability}%)`);

      // Rate limit: 1 AI call per second
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  // Update daily stats
  updateDailyStats(today);
  console.log(`[CRON] Done. Inserted ${totalInserted} predictions.`);
}

function updateDailyStats(date) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='loss' THEN 1 ELSE 0 END) as losses,
      SUM(is_banker) as bankers,
      SUM(CASE WHEN is_banker=1 AND status='win' THEN 1 ELSE 0 END) as banker_wins,
      AVG(probability) as avg_prob
    FROM predictions WHERE date = ?
  `).get(date);

  db.prepare(`
    INSERT INTO daily_stats (date, total, wins, losses, bankers, banker_wins, avg_prob)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET
      total=excluded.total, wins=excluded.wins, losses=excluded.losses,
      bankers=excluded.bankers, banker_wins=excluded.banker_wins, avg_prob=excluded.avg_prob
  `).run(date, stats.total, stats.wins||0, stats.losses||0, stats.bankers||0, stats.banker_wins||0, Math.round(stats.avg_prob||0));
}

// ── RESULT UPDATER ───────────────────────────────────────────
async function updateResults() {
  // Fetch completed match scores and mark win/loss
  const pending = db.prepare(`
    SELECT * FROM predictions
    WHERE status = 'pending'
    AND date <= date('now', '-1 day')
  `).all();

  for (const p of pending) {
    try {
      // Fetch result from Odds API scores endpoint
      const league = CONFIG.LEAGUES.find(l => l.name === p.league);
      if (!league) continue;

      const url = `https://api.the-odds-api.com/v4/sports/${league.key}/scores/?apiKey=${CONFIG.ODDS_API_KEY}&daysFrom=3`;
      const res = await fetch(url);
      const scores = await res.json();
      const game = scores.find(s => s.id === p.match_id);
      if (!game?.completed || !game.scores) continue;

      const homeScore = parseInt(game.scores.find(s => s.name === p.home_team)?.score || 0);
      const awayScore = parseInt(game.scores.find(s => s.name === p.away_team)?.score || 0);
      const favIsHome = p.favorite === p.home_team;
      const margin = favIsHome ? homeScore - awayScore : awayScore - homeScore;

      const requiredMargin = p.handicap === 'H1' ? 1 : p.handicap === 'H2' ? 2 : 3;
      const result = margin >= requiredMargin ? 'win' : 'loss';

      db.prepare(`UPDATE predictions SET status=?, home_score=?, away_score=? WHERE id=?`)
        .run(result, homeScore, awayScore, p.id);

      console.log(`[RESULT] ${p.home_team} vs ${p.away_team}: ${homeScore}-${awayScore} → ${result.toUpperCase()}`);
    } catch (err) {
      console.error('[RESULT]', err.message);
    }
  }
  updateDailyStats(new Date().toISOString().split('T')[0]);
}

// ── SCHEDULER ────────────────────────────────────────────────
// Run daily at 7:00 AM
cron.schedule('0 7 * * *', runDailyUpdate);
// Check results every 2 hours
cron.schedule('0 */2 * * *', updateResults);

// ── API ROUTES ───────────────────────────────────────────────

// GET /api/predictions?date=today&league=all&min_prob=70&bankers_only=false
app.get('/api/predictions', (req, res) => {
  const {
    date = new Date().toISOString().split('T')[0],
    league = 'all',
    min_prob = 70,
    bankers_only = 'false',
  } = req.query;

  let query = `SELECT * FROM predictions WHERE date = ? AND probability >= ?`;
  const params = [date, parseInt(min_prob)];

  if (league !== 'all') { query += ` AND league = ?`; params.push(league); }
  if (bankers_only === 'true') { query += ` AND is_banker = 1`; }
  query += ` ORDER BY is_banker DESC, probability DESC`;

  const rows = db.prepare(query).all(...params);
  const parsed = rows.map(r => ({ ...r, insights: JSON.parse(r.insights || '[]') }));
  res.json({ success: true, date, count: parsed.length, predictions: parsed });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const todayPicks = db.prepare(`SELECT COUNT(*) as c FROM predictions WHERE date=?`).get(today);
  const todayBankers = db.prepare(`SELECT COUNT(*) as c FROM predictions WHERE date=? AND is_banker=1`).get(today);
  const overall = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='win' THEN 1 ELSE 0 END) as wins,
      ROUND(AVG(probability),0) as avg_prob
    FROM predictions WHERE status != 'pending'
  `).get();

  const winRate = overall.total > 0 ? Math.round((overall.wins / overall.total) * 100) : 0;

  res.json({
    today_picks: todayPicks.c,
    today_bankers: todayBankers.c,
    win_rate: winRate,
    avg_prob: overall.avg_prob || 0,
    total_predictions: overall.total,
  });
});

// GET /api/history?limit=20
app.get('/api/history', (req, res) => {
  const { limit = 20 } = req.query;
  const rows = db.prepare(`
    SELECT * FROM predictions
    WHERE status IN ('win','loss')
    ORDER BY date DESC, id DESC
    LIMIT ?
  `).all(parseInt(limit));
  res.json({ success: true, history: rows.map(r => ({ ...r, insights: JSON.parse(r.insights || '[]') })) });
});

// GET /api/analytics
app.get('/api/analytics', (req, res) => {
  const byLeague = db.prepare(`
    SELECT league, league_flag,
      COUNT(*) as total,
      SUM(CASE WHEN status='win' THEN 1 ELSE 0 END) as wins
    FROM predictions WHERE status != 'pending'
    GROUP BY league ORDER BY wins*1.0/total DESC
  `).all();

  const streak = db.prepare(`
    SELECT status FROM predictions
    WHERE status != 'pending'
    ORDER BY date DESC, id DESC LIMIT 20
  `).all();

  let currentStreak = 0, streakType = '';
  for (const r of streak) {
    if (!streakType) streakType = r.status;
    if (r.status === streakType) currentStreak++;
    else break;
  }

  const bankerStats = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN status='win' THEN 1 ELSE 0 END) as wins
    FROM predictions WHERE is_banker=1 AND status!='pending'
  `).get();

  res.json({
    by_league: byLeague.map(l => ({
      ...l,
      win_rate: l.total > 0 ? Math.round((l.wins / l.total) * 100) : 0,
    })),
    streak: { count: currentStreak, type: streakType },
    banker_rate: bankerStats.total > 0 ? Math.round((bankerStats.wins / bankerStats.total) * 100) : 0,
    banker_total: bankerStats.total,
  });
});

// POST /api/trigger — manually trigger daily fetch (for testing)
app.post('/api/trigger', async (req, res) => {
  res.json({ success: true, message: 'Daily update triggered' });
  runDailyUpdate(); // runs async in background
});

// GET /api/leagues
app.get('/api/leagues', (req, res) => {
  res.json(CONFIG.LEAGUES);
});

// ── START ────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 HandicapAI server running on http://localhost:${CONFIG.PORT}`);
  console.log(`📅 Daily fetch scheduled at 07:00 AM`);
  console.log(`🔄 Result checker runs every 2 hours\n`);
});

module.exports = app;
