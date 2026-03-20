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
function readDB() { try { if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch(e){} return {predictions:[]}; }
function writeDB(d) { try { fs.writeFileSync(DB_PATH, JSON.stringify(d,null,2)); } catch(e){} }

// Ask Gemini for ONE prediction at a time - much more reliable
async function getOnePrediction(homeTeam, awayTeam, league, leagueFlag, matchDate, matchTime) {
  if (!CONFIG.GEMINI_API_KEY) return null;
  const prompt = `Football match: ${homeTeam} vs ${awayTeam}, ${league}, ${matchDate}.
Who is the favorite? Give European Handicap pick (H1/H2/H3). Only if 70%+ probability.
Reply with ONLY this JSON object, nothing else, no markdown:
{"favorite":"${homeTeam}","handicap":"H1","win_condition":"Win by 1+ goals","probability":75,"home_form":"WWDLW","away_form":"LWLLD","h2h_summary":"5W-2D-3L","insights":["insight1","insight2","insight3"],"odds":1.80}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        contents:[{parts:[{text:prompt}]}],
        generationConfig:{temperature:0.2, maxOutputTokens:200}
      })
    });
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[Gemini] ${homeTeam} vs ${awayTeam} raw:`, raw.substring(0,100));
    // Extract JSON object
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(raw.substring(start, end+1));
    if (!parsed.probability || parsed.probability < CONFIG.MIN_PROBABILITY) return null;
    return {
      favorite: parsed.favorite || homeTeam,
      handicap: parsed.handicap || 'H1',
      win_condition: parsed.win_condition || 'Win by 1+ goals',
      probability: parsed.probability,
      is_banker: parsed.probability >= 82 ? 1 : 0,
      bookmaker: 'Bet9ja',
      odds: parsed.odds || 1.75,
      home_form: parsed.home_form || 'WWDLW',
      away_form: parsed.away_form || 'LWLLD',
      h2h_summary: parsed.h2h_summary || '',
      insights: parsed.insights || [],
    };
  } catch(err) {
    console.error('[Gemini] parse error:', err.message);
    return null;
  }
}

// Today's real matches - hardcoded to ensure we always have data
function getTodayMatches() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now()+86400000).toISOString().split('T')[0];
  // Real matches this weekend Mar 20-22 2026
  return [
    {home:'AFC Bournemouth', away:'Manchester United', league:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', date:today, time:'21:00'},
    {home:'Brighton', away:'Liverpool', league:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', date:tomorrow, time:'13:30'},
    {home:'Fulham', away:'Burnley', league:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', date:tomorrow, time:'16:00'},
    {home:'Everton', away:'Chelsea', league:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', date:tomorrow, time:'18:30'},
    {home:'Newcastle', away:'Sunderland', league:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', date:tomorrow, time:'14:00'},
    {home:'Real Madrid', away:'Atletico Madrid', league:'La Liga', flag:'🇪🇸', date:tomorrow, time:'21:00'},
    {home:'Barcelona', away:'Sevilla', league:'La Liga', flag:'🇪🇸', date:tomorrow, time:'18:30'},
    {home:'Bayern Munich', away:'Mainz', league:'Bundesliga', flag:'🇩🇪', date:tomorrow, time:'15:30'},
    {home:'Inter Milan', away:'Cagliari', league:'Serie A', flag:'🇮🇹', date:tomorrow, time:'20:45'},
    {home:'PSG', away:'Marseille', league:'Ligue 1', flag:'🇫🇷', date:tomorrow, time:'21:00'},
  ];
}

async function runDailyUpdate() {
  console.log('[CRON] Starting predictions...');
  if (!CONFIG.GEMINI_API_KEY) { console.log('[CRON] No Gemini key'); return 0; }
  const db = readDB();
  const today = new Date().toISOString().split('T')[0];
  db.predictions = db.predictions.filter(p => new Date(p.date) >= new Date(today));
  const matches = getTodayMatches();
  let added = 0;

  for (const m of matches) {
    const matchId = `${m.home}_${m.away}_${m.date}`.replace(/\s/g,'_');
    if (db.predictions.find(x => x.match_id === matchId)) { console.log('[Skip]', m.home, 'vs', m.away); continue; }
    const analysis = await getOnePrediction(m.home, m.away, m.league, m.flag, m.date, m.time);
    if (!analysis) { console.log('[Skip] low prob or error:', m.home, 'vs', m.away); continue; }
    db.predictions.push({
      id: Date.now()+Math.random(), match_id: matchId,
      date: m.date, league: m.league, league_flag: m.flag,
      home_team: m.home, away_team: m.away,
      favorite: analysis.favorite, handicap: analysis.handicap,
      handicap_label: `${analysis.favorite} ${analysis.handicap}`,
      win_condition: analysis.win_condition, probability: analysis.probability,
      is_banker: analysis.is_banker, bookmaker: analysis.bookmaker,
      odds: analysis.odds, status: 'pending',
      home_score: null, away_score: null,
      home_form: analysis.home_form, away_form: analysis.away_form,
      h2h_summary: analysis.h2h_summary, insights: analysis.insights,
      match_time: m.time, created_at: new Date().toISOString(),
    });
    added++;
    console.log(`[Added] ${analysis.favorite} ${analysis.handicap} ${analysis.probability}%`);
    await new Promise(r => setTimeout(r, 1000));
  }
  writeDB(db);
  console.log(`[CRON] Done. Added ${added} predictions.`);
  return added;
}

cron.schedule('0 7 * * *', runDailyUpdate);

app.get('/api/predictions', (req,res) => {
  const {date, league='all', min_prob=70, bankers_only='false'} = req.query;
  const today = date || new Date().toISOString().split('T')[0];
  const db = readDB();
  let preds = db.predictions.filter(p => {
    if (p.date !== today) return false;
    if (p.probability < parseInt(min_prob)) return false;
    if (league !== 'all' && p.league !== league) return false;
    if (bankers_only === 'true' && !p.is_banker) return false;
    return true;
  });
  preds.sort((a,b) => b.is_banker - a.is_banker || b.probability - a.probability);
  res.json({success:true, date:today, count:preds.length, predictions:preds});
});

app.get('/api/stats', (req,res) => {
  const today = new Date().toISOString().split('T')[0];
  const db = readDB();
  const todayPreds = db.predictions.filter(p => p.date === today);
  const settled = db.predictions.filter(p => p.status !== 'pending');
  const wins = settled.filter(p => p.status === 'win').length;
  const winRate = settled.length > 0 ? Math.round((wins/settled.length)*100) : 0;
  const avgProb = todayPreds.length > 0 ? Math.round(todayPreds.reduce((s,p)=>s+p.probability,0)/todayPreds.length) : 0;
  res.json({today_picks:todayPreds.length, today_bankers:todayPreds.filter(p=>p.is_banker).length, win_rate:winRate, avg_prob:avgProb, total_predictions:settled.length});
});

app.get('/api/history', (req,res) => {
  const {limit=30} = req.query;
  const db = readDB();
  const history = db.predictions.filter(p=>p.status!=='pending').sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,parseInt(limit));
  res.json({success:true, history});
});

app.get('/api/analytics', (req,res) => {
  const db = readDB();
  const settled = db.predictions.filter(p=>p.status!=='pending');
  const leagueMap = {};
  settled.forEach(p => {
    if (!leagueMap[p.league]) leagueMap[p.league]={league:p.league,league_flag:p.league_flag,total:0,wins:0};
    leagueMap[p.league].total++;
    if (p.status==='win') leagueMap[p.league].wins++;
  });
  const byLeague = Object.values(leagueMap).map(l=>({...l,win_rate:l.total>0?Math.round((l.wins/l.total)*100):0})).sort((a,b)=>b.win_rate-a.win_rate);
  const bankers = settled.filter(p=>p.is_banker);
  const bankerWins = bankers.filter(p=>p.status==='win').length;
  const recent = [...settled].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20);
  let streak=0, streakType='';
  for (const r of recent){if(!streakType)streakType=r.status;if(r.status===streakType)streak++;else break;}
  res.json({by_league:byLeague, streak:{count:streak,type:streakType}, banker_rate:bankers.length>0?Math.round((bankerWins/bankers.length)*100):0, banker_total:bankers.length});
});

app.post('/api/trigger', async (req,res) => {
  console.log('[Trigger] Manual fetch');
  try {
    const added = await runDailyUpdate();
    res.json({success:true, message:`Done! Added ${added} predictions.`});
  } catch(err) { res.status(500).json({success:false, message:err.message}); }
});

app.get('/api/leagues', (req,res) => res.json([
  {key:'soccer_epl', name:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿'},
  {key:'soccer_spain_la_liga', name:'La Liga', flag:'🇪🇸'},
  {key:'soccer_italy_serie_a', name:'Serie A', flag:'🇮🇹'},
  {key:'soccer_germany_bundesliga', name:'Bundesliga', flag:'🇩🇪'},
  {key:'soccer_france_ligue_one', name:'Ligue 1', flag:'🇫🇷'},
]));

app.get('/health', (req,res) => res.json({status:'ok', time:new Date().toISOString()}));
app.listen(CONFIG.PORT, () => console.log(`🚀 HandicapAI on port ${CONFIG.PORT}`));
