const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  MIN_PROBABILITY: 70,
  PORT: process.env.PORT || 3000,
};

const DB_PATH = path.join('/tmp', 'handicap_db.json');

function readDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {}
  return { predictions: [] };
}

function writeDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) { console.error('DB write error:', e.message); }
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 3000 }
    }),
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function runDailyUpdate() {
  console.log('[CRON] Starting daily AI prediction generation...');
  if (!CONFIG.GEMINI_API_KEY) { console.log('[CRON] No Gemini key'); return 0; }

  const today = new Date().toISOString().split('T')[0];
  const db = readDB();

  // Remove old predictions beyond 3 days
  db.predictions = db.predictions.filter(p => {
    const diff = (new Date(today) - new Date(p.date)) / 86400000;
    return diff < 3;
  });

  // Check if we already have today's predictions
  const todayPreds = db.predictions.filter(p => p.date === today);
  if (todayPreds.length >= 5) {
    console.log(`[CRON] Already have ${todayPreds.length} predictions for today`);
    return todayPreds.length;
  }

  const prompt = `Today is ${today}. You are an expert football analyst for European Handicap betting.

Generate 15 high-probability European Handicap predictions for TODAY's and TOMORROW's real football matches across these leagues: Premier League, La Liga, Serie A, Bundesliga, Ligue 1.

For each match pick the FAVORITE team and assign H1 (win by 1+), H2 (win by 2+), or H3 (win by 3+).
Only include picks with 70%+ probability.
Mark picks with 82%+ probability as bankers.

Use real upcoming matches you know about. If no matches today use tomorrow's matches.

Respond ONLY with a valid JSON array, no markdown, no explanation:
[
  {
    "date": "YYYY-MM-DD",
    "league": "Premier League",
    "league_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    "home_team": "Team A",
    "away_team": "Team B",
    "favorite": "Team A",
    "handicap": "H1",
    "handicap_label": "Team A H1",
    "win_condition": "Win by 1+ goals",
    "probability": 78,
    "is_banker": false,
    "bookmaker": "Bet9ja",
    "odds": 1.75,
    "home_form": "WWDLW",
    "away_form": "LWLLD",
    "h2h_summary": "H2H 5W-2D-3L",
    "insights": ["Strong home record", "Away side struggling", "Top scorer fit"],
    "match_time": "20:00"
  }
]`;

  try {
    const text = await callGemini(prompt);
    const clean = text.replace(/```json|```/g, '').trim();
    const predictions = JSON.parse(clean);

    let added = 0;
    for (const p of predictions) {
      if (!p.probability || p.probability < CONFIG.MIN_PROBABILITY) continue;
      const matchId = `ai_${p.home_team}_${p.away_team}_${p.date}`.replace(/\s/g, '_');
      if (db.predictions.find(x => x.match_id === matchId)) continue;

      db.predictions.push({
        id: Date.now() + Math.random(),
        match_id: matchId,
        date: p.date || today,
        league: p.league,
        league_flag: p.league_flag || '⚽',
        home_team: p.home_team,
        away_team: p.away_team,
        favorite: p.favorite,
        handicap: p.handicap,
        handicap_label: p.handicap_label || `${p.favorite} ${p.handicap}`,
        win_condition: p.win_condition,
        probability: p.probability,
        is_banker: p.probability >= 82 ? 1 : 0,
        bookmaker: p.bookmaker || 'Bet9ja',
        odds: p.odds || 1.75,
        status: 'pending',
        home_score: null,
        away_score: null,
        home_form: p.home_form || 'WWDLW',
        away_form: p.away_form || 'LWLLL',
        h2h_summary: p.h2h_summary || '',
        insights: p.insights || [],
        match_time: p.match_time || '15:00',
        created_at: new Date().toISOString(),
      });
      added++;
    }

    writeDB(db);
    console.log(`[CRON] Done. Added ${added} AI predictions.`);
    return added;
  } catch (err) {
    console.error('[CRON] Error:', err.message);
    return 0;
  }
}

cron.schedule('0 7 * * *', runDailyUpdate);

app.get('/api/predictions', (req, res) => {
  const { date, league = 'all', min_prob = 70, bankers_only = 'false' } = req.query;
  const today = date || new Date().toISOString().split('T')[0];
  const db = readDB();
  let preds = db.predictions.filter(p => {
    if (p.date !== today) return false;
    if (p.probability < parseInt(min_prob)) return false;
    if (league !== 'all' && p.league !== league) return false;
    if (bankers_only === 'true' && !p.is_banker) return false;
    return true;
  });
  preds.sort((a, b) => b.is_banker - a.is_banker || b.probability - a.probability);
  res.json({ success: true, date: today, count: preds.length, predictions: preds });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const db = readDB();
  const todayPreds = db.predictions.filter(p => p.date === today);
  const settled = db.predictions.filter(p => p.status !== 'pending');
  const wins = settled.filter(p => p.status === 'win').length;
  const winRate = settled.length > 0 ? Math.round((wins / settled.length) * 100) : 0;
  const avgProb = todayPreds.length > 0 ? Math.round(todayPreds.reduce((s, p) => s + p.probability, 0) / todayPreds.length) : 0;
  res.json({ today_picks: todayPreds.length, today_bankers: todayPreds.filter(p => p.is_banker).length, win_rate: winRate, avg_prob: avgProb, total_predictions: settled.length });
});

app.get('/api/history', (req, res) => {
  const { limit = 30 } = req.query;
  const db = readDB();
  const history = db.predictions.filter(p => p.status !== 'pending').sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, parseInt(limit));
  res.json({ success: true, history });
});

app.get('/api/analytics', (req, res) => {
  const db = readDB();
  const settled = db.predictions.filter(p => p.status !== 'pending');
  const leagueMap = {};
  settled.forEach(p => {
    if (!leagueMap[p.league]) leagueMap[p.league] = { league: p.league, league_flag: p.league_flag, total: 0, wins: 0 };
    leagueMap[p.league].total++;
    if (p.status === 'win') leagueMap[p.league].wins++;
  });
  const byLeague = Object.values(leagueMap).map(l => ({ ...l, win_rate: l.total > 0 ? Math.round((l.wins / l.total) * 100) : 0 })).sort((a, b) => b.win_rate - a.win_rate);
  const bankers = settled.filter(p => p.is_banker);
  const bankerWins = bankers.filter(p => p.status === 'win').length;
  const recent = [...settled].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
  let streak = 0, streakType = '';
  for (const r of recent) { if (!streakType) streakType = r.status; if (r.status === streakType) streak++; else break; }
  res.json({ by_league: byLeague, streak: { count: streak, type: streakType }, banker_rate: bankers.length > 0 ? Math.round((bankerWins / bankers.length) * 100) : 0, banker_total: bankers.length });
});

app.post('/api/trigger', async (req, res) => {
  console.log('[Trigger] Manual fetch triggered');
  try {
    const added = await runDailyUpdate();
    res.json({ success: true, message: `Done! Added ${added} predictions.` });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/api/leagues', (req, res) => res.json([
  { key: 'soccer_epl', name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { key: 'soccer_spain_la_liga', name: 'La Liga', flag: '🇪🇸' },
  { key: 'soccer_italy_serie_a', name: 'Serie A', flag: '🇮🇹' },
  { key: 'soccer_germany_bundesliga', name: 'Bundesliga', flag: '🇩🇪' },
  { key: 'soccer_france_ligue_one', name: 'Ligue 1', flag: '🇫🇷' },
]));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(CONFIG.PORT, () => console.log(`🚀 HandicapAI running on port ${CONFIG.PORT}`));
