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
  ODDS_API_KEY: process.env.ODDS_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  MIN_PROBABILITY: 70,
  PORT: process.env.PORT || 3000,
  LEAGUES: [
    { key: 'soccer_epl', name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { key: 'soccer_spain_la_liga', name: 'La Liga', flag: '🇪🇸' },
    { key: 'soccer_italy_serie_a', name: 'Serie A', flag: '🇮🇹' },
    { key: 'soccer_germany_bundesliga', name: 'Bundesliga', flag: '🇩🇪' },
    { key: 'soccer_france_ligue_one', name: 'Ligue 1', flag: '🇫🇷' },
  ],
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

// Fetch matches - no bookmaker filter so we get ALL available matches
async function fetchOddsForLeague(leagueKey) {
  try {
    if (!CONFIG.ODDS_API_KEY) return [];
    const url = `https://api.the-odds-api.com/v4/sports/${leagueKey}/odds/?apiKey=${CONFIG.ODDS_API_KEY}&regions=eu,uk,us&markets=h2h&oddsFormat=decimal`;
    console.log(`[Odds] Fetching ${leagueKey}...`);
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      console.error(`[Odds] ${leagueKey} error ${res.status}:`, txt);
      return [];
    }
    const data = await res.json();
    console.log(`[Odds] ${leagueKey}: ${data.length} matches found`);
    return data;
  } catch (err) {
    console.error(`[OddsAPI] ${leagueKey}:`, err.message);
    return [];
  }
}

async function analyzeMatchWithGemini(match, leagueMeta) {
  if (!CONFIG.GEMINI_API_KEY) return null;

  // Get best available bookmaker from the match
  const bookmaker = match.bookmakers?.[0]?.key || 'bet9ja';
  const bookmakerTitle = match.bookmakers?.[0]?.title || 'Bet9ja';

  const prompt = `You are a football European Handicap betting analyst.
Match: ${match.home_team} vs ${match.away_team}
League: ${leagueMeta.name}
Date: ${match.commence_time}

Analyze and select the best European Handicap pick for the FAVORITE team.
H1 = favorite wins by 1+ goals
H2 = favorite wins by 2+ goals
H3 = favorite wins by 3+ goals

Only set probability if 70%+, otherwise null.

Respond ONLY with valid JSON no markdown:
{"favorite":"exact team name","handicap":"H1","win_condition":"Win by 1+ goals","probability":75,"is_banker":false,"home_form":"WWDLW","away_form":"LWLLD","h2h_summary":"H2H 5W-2D-3L","insights":["tag1","tag2","tag3"],"bookmaker":"${bookmakerTitle}","odds":1.75}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 400 }
      }),
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    console.log(`[Gemini] ${match.home_team} vs ${match.away_team}: ${parsed.favorite} ${parsed.handicap} ${parsed.probability}%`);
    return parsed;
  } catch (err) {
    console.error('[Gemini]', match.home_team, ':', err.message);
    return null;
  }
}

async function runDailyUpdate() {
  console.log('[CRON] Starting daily update...');
  const db = readDB();
  let added = 0;
  const twoDaysLater = new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0];

  for (const league of CONFIG.LEAGUES) {
    const matches = await fetchOddsForLeague(league.key);
    for (const match of matches) {
      const matchDate = new Date(match.commence_time).toISOString().split('T')[0];
      if (matchDate > twoDaysLater) continue;
      if (db.predictions.find(p => p.match_id === match.id)) {
        console.log(`[Skip] Already have ${match.home_team} vs ${match.away_team}`);
        continue;
      }
      const analysis = await analyzeMatchWithGemini(match, league);
      if (!analysis || !analysis.probability || analysis.probability < CONFIG.MIN_PROBABILITY) {
        console.log(`[Skip] Low prob or no analysis for ${match.home_team} vs ${match.away_team}`);
        continue;
      }
      db.predictions.push({
        id: Date.now() + Math.random(),
        match_id: match.id,
        date: matchDate,
        league: league.name,
        league_flag: league.flag,
        home_team: match.home_team,
        away_team: match.away_team,
        favorite: analysis.favorite,
        handicap: analysis.handicap,
        handicap_label: `${analysis.favorite} ${analysis.handicap}`,
        win_condition: analysis.win_condition,
        probability: analysis.probability,
        is_banker: analysis.probability >= 82 ? 1 : 0,
        bookmaker: analysis.bookmaker || 'Bet9ja',
        odds: analysis.odds || 1.75,
        status: 'pending',
        home_score: null,
        away_score: null,
        home_form: analysis.home_form || 'WWDLW',
        away_form: analysis.away_form || 'LWLLL',
        h2h_summary: analysis.h2h_summary || '',
        insights: analysis.insights || [],
        match_time: new Date(match.commence_time).toTimeString().slice(0, 5),
        created_at: new Date().toISOString(),
      });
      added++;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  writeDB(db);
  console.log(`[CRON] Done. Added ${added} new predictions.`);
  return added;
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
  const added = await runDailyUpdate();
  res.json({ success: true, message: `Fetch complete. Added ${added} predictions.` });
});

app.get('/api/leagues', (req, res) => res.json(CONFIG.LEAGUES));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(CONFIG.PORT, () => console.log(`🚀 HandicapAI running on port ${CONFIG.PORT}`));
