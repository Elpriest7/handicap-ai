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

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const DB = path.join('/tmp', 'db.json');

// ── DATABASE ──────────────────────────────────────────────────
function load() {
  try { if (fs.existsSync(DB)) return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch(e){}
  return { predictions: [] };
}
function save(d) { try { fs.writeFileSync(DB, JSON.stringify(d)); } catch(e){} }

// ── GEMINI ────────────────────────────────────────────────────
async function askGemini(home, away, league) {
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `Who is the favorite in ${home} vs ${away} (${league})? Give European Handicap pick.
Reply with ONLY valid JSON like this example (no extra text):
{"fav":"Team Name","h":"H1","prob":75,"odds":1.80,"hf":"WWDLW","af":"LWLLD","h2h":"5W-2D-3L","tips":["tip1","tip2","tip3"]}
Rules: h must be H1 H2 or H3. prob must be 70-95. Only reply if prob is 70 or higher otherwise reply: {"skip":true}`;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1, maxOutputTokens:150} })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s < 0 || e < 0) return null;
    const j = JSON.parse(txt.slice(s, e+1));
    if (j.skip) return null;
    if (!j.prob || j.prob < 70) return null;
    return j;
  } catch(err) { console.log('Gemini err:', err.message); return null; }
}

// ── MATCHES ───────────────────────────────────────────────────
function getFixtures() {
  const d0 = new Date().toISOString().split('T')[0];
  const d1 = new Date(Date.now()+86400000).toISOString().split('T')[0];
  const d2 = new Date(Date.now()+172800000).toISOString().split('T')[0];
  return [
    // Today
    {h:'AFC Bournemouth',a:'Manchester United',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d0,tm:'21:00'},
    // Tomorrow
    {h:'Brighton',a:'Liverpool',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d1,tm:'13:30'},
    {h:'Fulham',a:'Burnley',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d1,tm:'16:00'},
    {h:'Everton',a:'Chelsea',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d1,tm:'18:30'},
    {h:'Leeds United',a:'Brentford',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d1,tm:'21:00'},
    {h:'Barcelona',a:'Sevilla',lg:'La Liga',fl:'🇪🇸',dt:d1,tm:'18:30'},
    {h:'Real Madrid',a:'Atletico Madrid',lg:'La Liga',fl:'🇪🇸',dt:d1,tm:'21:00'},
    {h:'Bayern Munich',a:'Mainz',lg:'Bundesliga',fl:'🇩🇪',dt:d1,tm:'15:30'},
    {h:'Dortmund',a:'Stuttgart',lg:'Bundesliga',fl:'🇩🇪',dt:d1,tm:'18:30'},
    {h:'Inter Milan',a:'Cagliari',lg:'Serie A',fl:'🇮🇹',dt:d1,tm:'20:45'},
    {h:'Juventus',a:'Lecce',lg:'Serie A',fl:'🇮🇹',dt:d1,tm:'18:00'},
    {h:'PSG',a:'Marseille',lg:'Ligue 1',fl:'🇫🇷',dt:d1,tm:'21:00'},
    // Day after
    {h:'Newcastle',a:'Sunderland',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d2,tm:'14:00'},
    {h:'Aston Villa',a:'West Ham',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d2,tm:'16:15'},
    {h:'Tottenham',a:'Nottm Forest',lg:'Premier League',fl:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',dt:d2,tm:'16:15'},
  ];
}

// ── FETCH PREDICTIONS ─────────────────────────────────────────
async function fetchPredictions() {
  console.log('[AI] Fetching predictions...');
  const db = load();
  const today = new Date().toISOString().split('T')[0];
  // Remove predictions older than 3 days
  db.predictions = db.predictions.filter(p => {
    const diff = (new Date(today) - new Date(p.date)) / 86400000;
    return diff <= 3;
  });
  const fixtures = getFixtures();
  let added = 0;

  for (const f of fixtures) {
    const mid = `${f.h}_${f.a}_${f.dt}`.replace(/\s/g,'_');
    if (db.predictions.find(p => p.match_id === mid)) continue;

    const ai = await askGemini(f.h, f.a, f.lg);
    if (!ai) { console.log('[Skip]', f.h, 'vs', f.a); continue; }

    const hcap = ai.h || 'H1';
    const fav = ai.fav || f.h;
    db.predictions.push({
      id: `${Date.now()}${Math.random()}`.replace('.',''),
      match_id: mid,
      date: f.dt,
      league: f.lg,
      league_flag: f.fl,
      home_team: f.h,
      away_team: f.a,
      favorite: fav,
      handicap: hcap,
      handicap_label: `${fav} ${hcap}`,
      win_condition: hcap==='H1'?'Win by 1+ goals':hcap==='H2'?'Win by 2+ goals':'Win by 3+ goals',
      probability: ai.prob,
      is_banker: ai.prob >= 82 ? 1 : 0,
      bookmaker: 'Bet9ja',
      odds: ai.odds || 1.75,
      status: 'pending',
      home_score: null,
      away_score: null,
      home_form: ai.hf || 'WWDLW',
      away_form: ai.af || 'LWLLL',
      h2h_summary: ai.h2h || '',
      insights: ai.tips || [],
      match_time: f.tm,
      created_at: new Date().toISOString(),
    });
    added++;
    console.log(`[+] ${fav} ${hcap} ${ai.prob}% — ${f.h} vs ${f.a}`);
    await new Promise(r => setTimeout(r, 1200));
  }

  save(db);
  console.log(`[AI] Done. Added ${added} predictions.`);
  return added;
}

// ── SCHEDULER ─────────────────────────────────────────────────
cron.schedule('0 7 * * *', fetchPredictions);

// ── ROUTES ────────────────────────────────────────────────────
app.get('/api/predictions', (req, res) => {
  const { date, league='all', min_prob='70', bankers_only='false' } = req.query;
  const day = date || new Date().toISOString().split('T')[0];
  const db = load();
  let list = db.predictions.filter(p =>
    p.date === day &&
    p.probability >= parseInt(min_prob) &&
    (league === 'all' || p.league === league) &&
    (bankers_only !== 'true' || p.is_banker)
  );
  list.sort((a,b) => b.is_banker - a.is_banker || b.probability - a.probability);
  res.json({ success:true, date:day, count:list.length, predictions:list });
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const db = load();
  const tp = db.predictions.filter(p => p.date === today);
  const done = db.predictions.filter(p => p.status !== 'pending');
  const wins = done.filter(p => p.status === 'win').length;
  res.json({
    today_picks: tp.length,
    today_bankers: tp.filter(p=>p.is_banker).length,
    win_rate: done.length ? Math.round(wins/done.length*100) : 0,
    avg_prob: tp.length ? Math.round(tp.reduce((s,p)=>s+p.probability,0)/tp.length) : 0,
    total_predictions: done.length,
  });
});

app.get('/api/history', (req, res) => {
  const db = load();
  const h = db.predictions.filter(p=>p.status!=='pending').sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,30);
  res.json({ success:true, history:h });
});

app.get('/api/analytics', (req, res) => {
  const db = load();
  const done = db.predictions.filter(p=>p.status!=='pending');
  const lm = {};
  done.forEach(p => {
    if (!lm[p.league]) lm[p.league]={league:p.league,league_flag:p.league_flag,total:0,wins:0};
    lm[p.league].total++;
    if (p.status==='win') lm[p.league].wins++;
  });
  const bl = Object.values(lm).map(l=>({...l,win_rate:l.total?Math.round(l.wins/l.total*100):0})).sort((a,b)=>b.win_rate-a.win_rate);
  const bk = done.filter(p=>p.is_banker);
  const bkw = bk.filter(p=>p.status==='win').length;
  const rec = [...done].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20);
  let st=0,stt='';
  for(const r of rec){if(!stt)stt=r.status;if(r.status===stt)st++;else break;}
  res.json({ by_league:bl, streak:{count:st,type:stt}, banker_rate:bk.length?Math.round(bkw/bk.length*100):0, banker_total:bk.length });
});

app.post('/api/trigger', async (req, res) => {
  try {
    const n = await fetchPredictions();
    res.json({ success:true, message:`Added ${n} predictions` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Quick seed for instant demo data
app.get('/api/seed', (req, res) => {
  const db = load();
  const d0 = new Date().toISOString().split('T')[0];
  const d1 = new Date(Date.now()+86400000).toISOString().split('T')[0];
  const seeds = [
    {match_id:'bou_mun',date:d0,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'AFC Bournemouth',away_team:'Manchester United',favorite:'Manchester United',handicap:'H1',handicap_label:'Man United H1',win_condition:'Win by 1+ goals',probability:74,is_banker:0,bookmaker:'Bet9ja',odds:1.90,status:'pending',home_form:'LWDLL',away_form:'WWDLW',h2h_summary:'MUN 5W last 8',insights:['Away side stronger','United good form','Bournemouth inconsistent'],match_time:'21:00'},
    {match_id:'bri_liv',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Brighton',away_team:'Liverpool',favorite:'Liverpool',handicap:'H1',handicap_label:'Liverpool H1',win_condition:'Win by 1+ goals',probability:78,is_banker:0,bookmaker:'Bet9ja',odds:1.85,status:'pending',home_form:'DWLDD',away_form:'WWWDW',h2h_summary:'LIV 6W last 9',insights:['Liverpool top form','Brighton defensive','Title charge momentum'],match_time:'13:30'},
    {match_id:'ful_bur',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Fulham',away_team:'Burnley',favorite:'Fulham',handicap:'H2',handicap_label:'Fulham H2',win_condition:'Win by 2+ goals',probability:83,is_banker:1,bookmaker:'1xBet',odds:2.10,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'FUL 5W last 6 home',insights:['🔥 Home dominant','Burnley bottom 3','Avg 3.1 goals'],match_time:'16:00'},
    {match_id:'eve_che',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Everton',away_team:'Chelsea',favorite:'Chelsea',handicap:'H1',handicap_label:'Chelsea H1',win_condition:'Win by 1+ goals',probability:76,is_banker:0,bookmaker:'Betway',odds:1.80,status:'pending',home_form:'LLDLL',away_form:'WWWLW',h2h_summary:'CHE 4W last 6',insights:['Chelsea in form','Everton relegation zone','Strong away record'],match_time:'18:30'},
    {match_id:'bar_sev',date:d1,league:'La Liga',league_flag:'🇪🇸',home_team:'Barcelona',away_team:'Sevilla',favorite:'Barcelona',handicap:'H2',handicap_label:'Barcelona H2',win_condition:'Win by 2+ goals',probability:86,is_banker:1,bookmaker:'1xBet',odds:1.95,status:'pending',home_form:'WWWWW',away_form:'LLDLL',h2h_summary:'BAR 7W last 9',insights:['🔥 Barca 8 game streak','Sevilla away poor','Avg 3.4 goals'],match_time:'18:30'},
    {match_id:'rma_atm',date:d1,league:'La Liga',league_flag:'🇪🇸',home_team:'Real Madrid',away_team:'Atletico Madrid',favorite:'Real Madrid',handicap:'H1',handicap_label:'Real Madrid H1',win_condition:'Win by 1+ goals',probability:72,is_banker:0,bookmaker:'Bet9ja',odds:2.05,status:'pending',home_form:'WWDWW',away_form:'WDWLW',h2h_summary:'RMA 5W last 8 home',insights:['Madrid home fortress','Derby tension','Top scorer fit'],match_time:'21:00'},
    {match_id:'bay_mai',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Bayern Munich',away_team:'Mainz',favorite:'Bayern Munich',handicap:'H2',handicap_label:'Bayern H2',win_condition:'Win by 2+ goals',probability:88,is_banker:1,bookmaker:'Bet9ja',odds:1.75,status:'pending',home_form:'WWWWW',away_form:'LLLLD',h2h_summary:'BAY 8W last 10',insights:['🔥 Bayern dominant','Mainz struggling','Kane in top form'],match_time:'15:30'},
    {match_id:'int_cag',date:d1,league:'Serie A',league_flag:'🇮🇹',home_team:'Inter Milan',away_team:'Cagliari',favorite:'Inter Milan',handicap:'H2',handicap_label:'Inter H2',win_condition:'Win by 2+ goals',probability:85,is_banker:1,bookmaker:'Betway',odds:1.80,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'INT 6W last 7 home',insights:['Inter title chasing','Cagliari relegation','Strong attack'],match_time:'20:45'},
    {match_id:'psg_mar',date:d1,league:'Ligue 1',league_flag:'🇫🇷',home_team:'PSG',away_team:'Marseille',favorite:'PSG',handicap:'H1',handicap_label:'PSG H1',win_condition:'Win by 1+ goals',probability:80,is_banker:0,bookmaker:'1xBet',odds:1.70,status:'pending',home_form:'WWWWL',away_form:'DWLLD',h2h_summary:'PSG 6W last 8',insights:['PSG strong home','Le Classique fire','Marseille inconsistent'],match_time:'21:00'},
    {match_id:'juv_lec',date:d1,league:'Serie A',league_flag:'🇮🇹',home_team:'Juventus',away_team:'Lecce',favorite:'Juventus',handicap:'H2',handicap_label:'Juventus H2',win_condition:'Win by 2+ goals',probability:82,is_banker:1,bookmaker:'Bet9ja',odds:1.85,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'JUV 5W last 6 home',insights:['🔥 Juve home record','Lecce poor away','Clean sheet streak'],match_time:'18:00'},
  ];
  let added = 0;
  seeds.forEach(s => {
    if (!db.predictions.find(x => x.match_id === s.match_id)) {
      db.predictions.push({...s, id:`seed_${s.match_id}`, home_score:null, away_score:null, created_at:new Date().toISOString()});
      added++;
    }
  });
  save(db);
  res.json({ success:true, message:`Seeded ${added} predictions! Refresh your site now.`, total: db.predictions.length });
});

app.get('/api/leagues', (req,res) => res.json([
  {key:'epl',name:'Premier League',flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿'},
  {key:'la_liga',name:'La Liga',flag:'🇪🇸'},
  {key:'serie_a',name:'Serie A',flag:'🇮🇹'},
  {key:'bundesliga',name:'Bundesliga',flag:'🇩🇪'},
  {key:'ligue_1',name:'Ligue 1',flag:'🇫🇷'},
]));

app.get('/health', (req,res) => res.json({status:'ok', time:new Date().toISOString()}));

app.listen(PORT, () => console.log(`🚀 HandicapAI running on port ${PORT}`));
