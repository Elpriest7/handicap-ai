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
  try { if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) {}
  return { predictions: [] };
}

function writeDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4000 }
    }),
  });
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  console.log('[Gemini] Raw response length:', text.length);
  return text;
}

function extractJSON(text) {
  // Try to find JSON array in text
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found');
  const jsonStr = text.substring(start, end + 1);
  return JSON.parse(jsonStr);
}

async function runDailyUpdate() {
  console.log('[CRON] Starting daily AI prediction generation...');
  if (!CONFIG.GEMINI_API_KEY) { console.log('[CRON] No Gemini key set'); return 0; }

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const db = readDB();

  // Clean old predictions
  db.predictions = db.predictions.filter(p => new Date(p.date) >= new Date(today));

  const existing = db.predictions.filter(p => p.date === today || p.date === tomorrow);
  if (existing.length >= 8) {
    console.log(`[CRON] Already have ${existing.length} predictions`);
    return existing.length;
  }

  // Ask for fewer predictions to avoid truncation
  const prompt = `Today is ${today}. You are a football European Handicap analyst.

List 8 real football matches happening on ${today} or ${tomorrow} in Premier League, La Liga, Serie A, Bundesliga, or Ligue 1.

For each match select European Handicap for the favorite:
H1 = win by 1+ goals (probability 70-79%)
H2 = win by 2+ goals (probability 75-85%)  
H3 = win by 3+ goals (probability 82-92%, banker=true)

Return ONLY a JSON array. Keep it short. No explanation:
[{"date":"${today}","league":"Premier League","league_flag":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","home_team":"Arsenal","away_team":"Wolves","favorite":"Arsenal","handicap":"H2","handicap_label":"Arsenal H2","win_condition":"Win by 2+ goals","probability":82,"is_banker":true,"bookmaker":"Bet9ja","odds":1.85,"home_form":"WWWDW","away_form":"LLLLD","h2h_summary":"Arsenal 6W last 8","insights":["Strong home form","Wolves struggling","Top scorer fit"],"match_time":"20:00"}]`;

  try {
    const text = await callGemini(prompt);
    const predictions = extractJSON(text);
    console.log('[CRON] Parsed', predictions.length, 'predictions');

    let added = 0;
    for (const p of predictions) {
      if (!p.probability || p.probability < CONFIG.MIN_PROBABILITY) continue;
      const matchId = `ai_${p.home_team}_${p.away_team}_${p.date}`.replace(/\s/g,'_');
      if (db.predictions.find(x => x.match_id === matchId)) continue;

      db.predictions.push({
        id: Date.now() + Math.random(),
        match_id: matchId,
        date: p.date || today,
        league: p.league || 'Premier League',
        league_flag: p.league_flag || '⚽',
        home_team: p.home_team,
        away_team: p.away_team,
        favorite: p.favorite,
        handicap: p.handicap,
        handicap_label: p.handicap_label || `${p.favorite} ${p.handicap}`,
        win_condition: p.win_condition || `Win by ${p.handicap.replace('H','')}+ goals`,
        probability: p.probability,
        is_banker: p.probability >= 82 ? 1 : 0,
        bookmaker: p.bookmaker || 'Bet9ja',
        odds: p.odds || 1.75,
        status: 'pending',
        home_score: null, away_score: null,
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
    console.log(`[CRON] Done. Added ${added} predictions.`);
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
    res.status(500).json({ success: false, message: err.message });
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
