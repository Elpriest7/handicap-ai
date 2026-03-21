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
const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || '';
const DB = path.join('/tmp', 'db.json');

// ── LEAGUE CODES (football-data.org) ─────────────────────────
const LEAGUES = [
  { code: 'PL',  name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  { code: 'PD',  name: 'La Liga',        flag: '🇪🇸' },
  { code: 'SA',  name: 'Serie A',        flag: '🇮🇹' },
  { code: 'BL1', name: 'Bundesliga',     flag: '🇩🇪' },
  { code: 'FL1', name: 'Ligue 1',        flag: '🇫🇷' },
];

// ── DATABASE ──────────────────────────────────────────────────
function load() {
  try { if (fs.existsSync(DB)) return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch(e){}
  return { predictions: [] };
}
function save(d) { try { fs.writeFileSync(DB, JSON.stringify(d)); } catch(e){} }

// ── FETCH REAL FIXTURES ───────────────────────────────────────
async function fetchFixtures() {
  if (!FOOTBALL_KEY) { console.log('[Football] No API key'); return []; }
  const today = new Date().toISOString().split('T')[0];
  const threeDays = new Date(Date.now() + 3*86400000).toISOString().split('T')[0];
  const allMatches = [];

  for (const league of LEAGUES) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${league.code}/matches?dateFrom=${today}&dateTo=${threeDays}&status=SCHEDULED`;
      const res = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_KEY } });
      if (!res.ok) { console.log(`[Football] ${league.code} error:`, res.status); continue; }
      const data = await res.json();
      const matches = (data.matches || []).map(m => ({
        id: `fd_${m.id}`,
        h: m.homeTeam.shortName || m.homeTeam.name,
        a: m.awayTeam.shortName || m.awayTeam.name,
        lg: league.name,
        fl: league.flag,
        dt: m.utcDate.split('T')[0],
        tm: m.utcDate.substring(11, 16),
      }));
      allMatches.push(...matches);
      console.log(`[Football] ${league.name}: ${matches.length} fixtures`);
    } catch(err) { console.error(`[Football] ${league.code}:`, err.message); }
    await new Promise(r => setTimeout(r, 500));
  }
  return allMatches;
}

// ── GEMINI ANALYSIS ───────────────────────────────────────────
async function askGemini(home, away, league) {
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `You are a strict European Handicap betting analyst. Analyze: ${home} vs ${away} (${league}).

EUROPEAN HANDICAP LOGIC:
- H1 = favorite must win by 1+ goals (opponent gets +1 goal head start)
- H2 = favorite must win by 2+ goals (opponent gets +2 goal head start)
- H3 = favorite must win by 3+ goals (opponent gets +3 goal head start)
- Only pick the favorite team — the stronger, more consistent side

STRICT SELECTION RULES — SKIP the match if ANY of these apply:
❌ Favorite lost 3 or more of last 5 matches
❌ Opponent is defensively strong (concedes less than 1 goal per game)
❌ Match looks unpredictable or evenly matched
❌ Handicap odds would be below 1.35 (too risky low value)
❌ Favorite has inconsistent recent form
❌ Low motivation match (nothing to play for)
❌ High chance of upset based on context
❌ Something looks "too easy" but recent form says otherwise

ONLY PICK if ALL of these are true:
✅ Favorite wins frequently and rarely loses
✅ Favorite has won 3 or more of last 5 matches
✅ Opponent is weak away or has poor recent form
✅ H2H history strongly favors the favorite
✅ Probability is genuinely 70% or higher
✅ Odds would be between 1.40 and 2.50

BANKER RULE: Only assign banker=true if probability is 80% or above AND all filters pass strongly.

HANDICAP SELECTION GUIDE (follow strictly):
- 70-74% = H3 (team strong enough to win by 3+)
- 75-79% = H2 (team strong enough to win by 2+)
- 80-89% = H1 (very high confidence, win by 1+ is enough)
- 90-95% = H1 BANKER (near certain win, safest pick)

IMPORTANT: Higher probability = LOWER handicap (H1)
Lower probability within 70%+ range = HIGHER handicap (H2/H3)
This reflects: if you're only 70-75% sure, you need bigger margin to justify the pick.
If you're 80%+ sure, H1 is the safe reliable pick.

Reply ONLY with valid JSON (no markdown, no text):
{"fav":"team name","h":"H1","prob":75,"banker":false,"odds":1.80,"hf":"WWDLW","af":"LWLLD","h2h":"5W-2D-3L","tips":["specific reason 1","specific reason 2","specific reason 3"]}

If match fails ANY filter above, reply ONLY: {"skip":true}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
      })
    });
    const d = await res.json();
    const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if (s < 0 || e < 0) return null;
    const j = JSON.parse(txt.slice(s, e+1));
    if (j.skip || !j.prob || j.prob < 70) return null;
    // Enforce odds filter — skip if odds too low
    if (j.odds && j.odds < 1.35) return null;
    // Banker only at 80%+
    j.banker = j.prob >= 80;
    return j;
  } catch(err) { console.log('[Gemini] err:', err.message); return null; }
}

// ── DAILY UPDATE ──────────────────────────────────────────────
async function runDailyUpdate() {
  console.log('[CRON] Starting daily update...');
  const db = load();
  const today = new Date().toISOString().split('T')[0];

  // Clean old predictions (older than 3 days)
  db.predictions = db.predictions.filter(p =>
    new Date(p.date) >= new Date(today)
  );

  // Get real fixtures from football-data.org
  const fixtures = await fetchFixtures();
  console.log(`[CRON] Got ${fixtures.length} real fixtures`);

  let added = 0;
  for (const f of fixtures) {
    const mid = f.id;
    if (db.predictions.find(p => p.match_id === mid)) {
      console.log('[Skip] Already have:', f.h, 'vs', f.a);
      continue;
    }

    const ai = await askGemini(f.h, f.a, f.lg);
    if (!ai) { console.log('[Skip] Low prob:', f.h, 'vs', f.a); continue; }

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
      is_banker: (ai.banker && ai.prob >= 80) ? 1 : 0,
      bookmaker: 'Bet9ja',
      odds: ai.odds || 1.75,
      status: 'pending',
      home_score: null, away_score: null,
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
  console.log(`[CRON] Done. Added ${added} predictions.`);
  return added;
}

// Run daily at 7am
cron.schedule('0 7 * * *', runDailyUpdate);

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
  const h = db.predictions
    .filter(p=>p.status!=='pending')
    .sort((a,b)=>new Date(b.date)-new Date(a.date))
    .slice(0,30);
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
  const bl = Object.values(lm)
    .map(l=>({...l, win_rate:l.total?Math.round(l.wins/l.total*100):0}))
    .sort((a,b)=>b.win_rate-a.win_rate);
  const bk = done.filter(p=>p.is_banker);
  const bkw = bk.filter(p=>p.status==='win').length;
  const rec = [...done].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,20);
  let st=0,stt='';
  for(const r of rec){if(!stt)stt=r.status;if(r.status===stt)st++;else break;}
  res.json({
    by_league: bl,
    streak: {count:st, type:stt},
    banker_rate: bk.length ? Math.round(bkw/bk.length*100) : 0,
    banker_total: bk.length,
  });
});

app.post('/api/trigger', async (req, res) => {
  console.log('[Trigger] Manual fetch triggered');
  try {
    const n = await runDailyUpdate();
    res.json({ success:true, message:`Done! Added ${n} predictions.` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Seed with real fixtures for this weekend
app.get('/api/seed', (req, res) => {
  const db = load();
  const d0 = new Date().toISOString().split('T')[0];
  const d1 = new Date(Date.now()+86400000).toISOString().split('T')[0];
  const d2 = new Date(Date.now()+172800000).toISOString().split('T')[0];
  const seeds = [
    // ── TODAY Mar 20 ──────────────────────────────────────────
    {match_id:'bou_mun',date:d0,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'AFC Bournemouth',away_team:'Manchester United',favorite:'Manchester United',handicap:'H1',handicap_label:'Man United H1',win_condition:'Win by 1+ goals',probability:74,is_banker:0,bookmaker:'Bet9ja',odds:1.90,status:'pending',home_form:'LWDLL',away_form:'WWDLW',h2h_summary:'MUN 5W last 8',insights:['Away side stronger','United good form','Bournemouth inconsistent'],match_time:'21:00'},
    {match_id:'rbl_tsg',date:d0,league:'Bundesliga',league_flag:'🇩🇪',home_team:'RB Leipzig',away_team:'TSG Hoffenheim',favorite:'RB Leipzig',handicap:'H2',handicap_label:'RB Leipzig H2',win_condition:'Win by 2+ goals',probability:83,is_banker:1,bookmaker:'Bet9ja',odds:1.80,status:'pending',home_form:'WWWDW',away_form:'LLDLL',h2h_summary:'RBL 6W last 8 home',insights:['🔥 Leipzig sharp','Hoffenheim away poor','High scoring games'],match_time:'20:30'},
    {match_id:'rcl_ang',date:d0,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Racing Club De Lens',away_team:'Angers SCO',favorite:'Racing Club De Lens',handicap:'H2',handicap_label:'Lens H2',win_condition:'Win by 2+ goals',probability:82,is_banker:1,bookmaker:'1xBet',odds:1.85,status:'pending',home_form:'WWWDW',away_form:'LLLLL',h2h_summary:'RCL 5W last 7 home',insights:['🔥 Lens dominant','Angers bottom','Strong home form'],match_time:'20:45'},
    // ── MAR 21 ────────────────────────────────────────────────
    // Premier League
    {match_id:'bri_liv',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Brighton',away_team:'Liverpool',favorite:'Liverpool',handicap:'H1',handicap_label:'Liverpool H1',win_condition:'Win by 1+ goals',probability:78,is_banker:0,bookmaker:'Bet9ja',odds:1.85,status:'pending',home_form:'DWLDD',away_form:'WWWDW',h2h_summary:'LIV 6W last 9',insights:['Liverpool title charge','Brighton solid home','Away side stronger'],match_time:'13:30'},
    {match_id:'ful_bur',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Fulham',away_team:'Burnley',favorite:'Fulham',handicap:'H2',handicap_label:'Fulham H2',win_condition:'Win by 2+ goals',probability:84,is_banker:1,bookmaker:'1xBet',odds:2.10,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'FUL 5W last 6 home',insights:['🔥 Home dominant','Burnley bottom 3','Avg 3.1 goals'],match_time:'16:00'},
    {match_id:'eve_che',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Everton',away_team:'Chelsea',favorite:'Chelsea',handicap:'H1',handicap_label:'Chelsea H1',win_condition:'Win by 1+ goals',probability:76,is_banker:0,bookmaker:'Betway',odds:1.80,status:'pending',home_form:'LLDLL',away_form:'WWWLW',h2h_summary:'CHE 4W last 6',insights:['Chelsea in form','Everton relegation zone','Strong away record'],match_time:'18:30'},
    // Bundesliga
    {match_id:'bmu_uni',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Bayern Munich',away_team:'Union Berlin',favorite:'Bayern Munich',handicap:'H2',handicap_label:'Bayern H2',win_condition:'Win by 2+ goals',probability:87,is_banker:1,bookmaker:'Bet9ja',odds:1.72,status:'pending',home_form:'WWWDW',away_form:'LLLLL',h2h_summary:'BAY 9W last 10 home',insights:['🔥 Bayern unstoppable','Union Berlin bottom','Kane in top form'],match_time:'15:30'},
    {match_id:'bvb_hsv',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Borussia Dortmund',away_team:'Hamburger SV',favorite:'Borussia Dortmund',handicap:'H1',handicap_label:'Dortmund H1',win_condition:'Win by 1+ goals',probability:76,is_banker:0,bookmaker:'Betway',odds:1.85,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'BVB 5W last 7 home',insights:['Dortmund strong home','HSV newly promoted','Signal Iduna atmosphere'],match_time:'18:30'},
    {match_id:'fch_lev',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'1. FC Heidenheim',away_team:'Bayer Leverkusen',favorite:'Bayer Leverkusen',handicap:'H1',handicap_label:'Leverkusen H1',win_condition:'Win by 1+ goals',probability:75,is_banker:0,bookmaker:'1xBet',odds:1.90,status:'pending',home_form:'LLDLL',away_form:'WWWDW',h2h_summary:'LEV 5W last 7',insights:['Leverkusen title push','Heidenheim struggling','Away side dominant'],match_time:'15:30'},
    // La Liga
    {match_id:'elc_mal',date:d1,league:'La Liga',league_flag:'🇪🇸',home_team:'Elche CF',away_team:'RCD Mallorca',favorite:'Elche CF',handicap:'H1',handicap_label:'Elche H1',win_condition:'Win by 1+ goals',probability:71,is_banker:0,bookmaker:'Bet9ja',odds:1.95,status:'pending',home_form:'WWDLW',away_form:'LWDLL',h2h_summary:'ELC 4W last 6 home',insights:['Home advantage','Mallorca away poor','Form edge'],match_time:'14:00'},
    // Serie A
    {match_id:'acm_tor',date:d1,league:'Serie A',league_flag:'🇮🇹',home_team:'AC Milan',away_team:'Torino FC',favorite:'AC Milan',handicap:'H1',handicap_label:'AC Milan H1',win_condition:'Win by 1+ goals',probability:78,is_banker:0,bookmaker:'Bet9ja',odds:1.80,status:'pending',home_form:'WWWDL',away_form:'LLDLL',h2h_summary:'MIL 5W last 7 home',insights:['Milan top 4 push','Torino poor away','San Siro advantage'],match_time:'18:00'},
    {match_id:'juv_sas',date:d1,league:'Serie A',league_flag:'🇮🇹',home_team:'Juventus Turin',away_team:'Sassuolo Calcio',favorite:'Juventus Turin',handicap:'H2',handicap_label:'Juventus H2',win_condition:'Win by 2+ goals',probability:83,is_banker:1,bookmaker:'1xBet',odds:1.85,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'JUV 5W last 6 home',insights:['🔥 Juve home record','Sassuolo poor away','Clean sheet streak'],match_time:'20:45'},
    // Ligue 1
    {match_id:'nic_psg',date:d1,league:'Ligue 1',league_flag:'🇫🇷',home_team:'OGC Nice',away_team:'Paris Saint-Germain',favorite:'Paris Saint-Germain',handicap:'H1',handicap_label:'PSG H1',win_condition:'Win by 1+ goals',probability:82,is_banker:1,bookmaker:'Bet9ja',odds:1.70,status:'pending',home_form:'WDLDD',away_form:'WWWWL',h2h_summary:'PSG 6W last 8 away',insights:['🔥 PSG dominant','Nice mid-table','Away side superior'],match_time:'21:05'},
    // ── MAR 22 ────────────────────────────────────────────────
    // Premier League
    {match_id:'new_sun',date:d2,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Newcastle United',away_team:'Sunderland',favorite:'Newcastle United',handicap:'H1',handicap_label:'Newcastle H1',win_condition:'Win by 1+ goals',probability:80,is_banker:0,bookmaker:'Bet9ja',odds:1.78,status:'pending',home_form:'WWWDW',away_form:'LWLLD',h2h_summary:'NEW 5W last 7 home',insights:['Tyne-Wear Derby','Newcastle top 4 push','Sunderland away poor'],match_time:'14:00'},
    {match_id:'avl_whu',date:d2,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Aston Villa',away_team:'West Ham',favorite:'Aston Villa',handicap:'H1',handicap_label:'Aston Villa H1',win_condition:'Win by 1+ goals',probability:74,is_banker:0,bookmaker:'1xBet',odds:1.90,status:'pending',home_form:'WWWLW',away_form:'DLWLL',h2h_summary:'AVL 4W last 6',insights:['Villa European chase','West Ham inconsistent','Strong home crowd'],match_time:'16:15'},
    {match_id:'tot_nfo',date:d2,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Tottenham',away_team:'Nottm Forest',favorite:'Tottenham',handicap:'H1',handicap_label:'Tottenham H1',win_condition:'Win by 1+ goals',probability:72,is_banker:0,bookmaker:'Betway',odds:1.95,status:'pending',home_form:'WWDWL',away_form:'WDLLL',h2h_summary:'TOT 4W last 7',insights:['Spurs home bounce','Forest travel badly','Top 4 battle'],match_time:'16:15'},
    // La Liga
    {match_id:'bar_rvc',date:d2,league:'La Liga',league_flag:'🇪🇸',home_team:'FC Barcelona',away_team:'Rayo Vallecano',favorite:'FC Barcelona',handicap:'H2',handicap_label:'Barcelona H2',win_condition:'Win by 2+ goals',probability:88,is_banker:1,bookmaker:'Bet9ja',odds:1.75,status:'pending',home_form:'WWWWW',away_form:'LLLDD',h2h_summary:'BAR 8W last 10 home',insights:['🔥 Barca 5 game streak','Rayo away terrible','Avg 3.6 goals at home'],match_time:'14:00'},
    {match_id:'rma_atm',date:d2,league:'La Liga',league_flag:'🇪🇸',home_team:'Real Madrid',away_team:'Atletico Madrid',favorite:'Real Madrid',handicap:'H1',handicap_label:'Real Madrid H1',win_condition:'Win by 1+ goals',probability:73,is_banker:0,bookmaker:'Bet9ja',odds:2.05,status:'pending',home_form:'WWDWW',away_form:'WDWLW',h2h_summary:'RMA 5W last 8 home',insights:['Madrid home fortress','El Derbi tension','Title race crunch'],match_time:'21:00'},
    // Serie A
    {match_id:'com_pis',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'Como 1907',away_team:'Pisa SC',favorite:'Como 1907',handicap:'H1',handicap_label:'Como H1',win_condition:'Win by 1+ goals',probability:80,is_banker:0,bookmaker:'Betway',odds:1.85,status:'pending',home_form:'WWWDL',away_form:'LLDLL',h2h_summary:'COM 5W last 7 home',insights:['Como strong home','Pisa away poor','Home dominance'],match_time:'12:30'},
    {match_id:'ata_ver',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'Atalanta BC',away_team:'Hellas Verona',favorite:'Atalanta BC',handicap:'H2',handicap_label:'Atalanta H2',win_condition:'Win by 2+ goals',probability:80,is_banker:0,bookmaker:'1xBet',odds:1.88,status:'pending',home_form:'WWWWL',away_form:'LLLLL',h2h_summary:'ATA 6W last 8 home',insights:['Atalanta top form','Verona relegated zone','Goals machine'],match_time:'15:00'},
    {match_id:'fio_int',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'ACF Fiorentina',away_team:'Inter Milano',favorite:'Inter Milano',handicap:'H1',handicap_label:'Inter H1',win_condition:'Win by 1+ goals',probability:74,is_banker:0,bookmaker:'Bet9ja',odds:2.00,status:'pending',home_form:'WWLWW',away_form:'WWWDW',h2h_summary:'INT 5W last 8',insights:['Inter title chasing','Fiorentina strong home','Away side quality'],match_time:'20:45'},
    {match_id:'rom_lec',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'AS Roma',away_team:'US Lecce',favorite:'AS Roma',handicap:'H1',handicap_label:'Roma H1',win_condition:'Win by 1+ goals',probability:76,is_banker:0,bookmaker:'Betway',odds:1.82,status:'pending',home_form:'WWDWL',away_form:'LLLDD',h2h_summary:'ROM 5W last 7 home',insights:['Roma home fortress','Lecce relegation battle','Olimpico pressure'],match_time:'18:00'},
    // Ligue 1
    {match_id:'ren_fcm',date:d2,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Stade Rennais FC',away_team:'FC Metz',favorite:'Stade Rennais FC',handicap:'H2',handicap_label:'Rennes H2',win_condition:'Win by 2+ goals',probability:82,is_banker:1,bookmaker:'1xBet',odds:1.90,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'REN 6W last 8 home',insights:['🔥 Rennes dominant','Metz bottom 3','Home goal machine'],match_time:'16:15'},
    {match_id:'olm_lil',date:d2,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Olympique Marseille',away_team:'Lille OSC',favorite:'Olympique Marseille',handicap:'H1',handicap_label:'Marseille H1',win_condition:'Win by 1+ goals',probability:73,is_banker:0,bookmaker:'Bet9ja',odds:1.95,status:'pending',home_form:'WWWLL',away_form:'WDLWL',h2h_summary:'OLM 4W last 7 home',insights:['Marseille Velodrome','Lille good form','Tight contest'],match_time:'16:15'},
  ];
  let added = 0;
  seeds.forEach(s => {
    if (!db.predictions.find(x => x.match_id === s.match_id)) {
      db.predictions.push({...s, id:`seed_${s.match_id}`, home_score:null, away_score:null, created_at:new Date().toISOString()});
      added++;
    }
  });
  save(db);
  res.json({ success:true, message:`Seeded ${added} predictions!`, total:db.predictions.length });
});

app.get('/api/leagues', (req,res) => res.json(LEAGUES));
app.get('/health', (req,res) => res.json({status:'ok', time:new Date().toISOString()}));
app.listen(PORT, () => console.log(`🚀 HandicapAI on port ${PORT}`));
