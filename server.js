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

HOW EUROPEAN HANDICAP WORKS:
The FAVORITE team gets a goal head start BEFORE the match begins.
- H1 = Favorite starts +1 up. Bet wins if favorite does NOT lose (win or draw is enough)
- H2 = Favorite starts +2 up. Bet wins unless favorite loses by 2+
- H3 = Favorite starts +3 up. Bet wins unless favorite loses by 3+
So H3 is SAFER than H1 for the bettor. H1 requires the most confidence.

STRICT SKIP RULES — Skip the match if ANY apply:
❌ Favorite lost 3 or more of last 5 matches
❌ Opponent is defensively strong (concedes less than 1 goal per game)
❌ Match is unpredictable or evenly matched
❌ Favorite has inconsistent or poor recent form
❌ Low motivation match
❌ High chance of upset
❌ Favorite looks strong but recent form says otherwise (trap)

ONLY PICK if ALL apply:
✅ Favorite wins frequently, rarely loses
✅ Favorite won at least 3 of last 5 matches
✅ Opponent is weak or in poor form
✅ H2H history strongly favors the favorite
✅ Probability is 70% or higher

HANDICAP SELECTION — Based on ODDS and FORM (most important rule):

If favorite odds are 1.80 to 2.50+ AND team is in form AND H2H good:
→ Pick H2 or H3 (big head start = easy win even if close game)

If favorite odds are 1.40 to 1.79 AND team is highly dominant AND H2H very strong:
→ Pick H1 (so dominant they simply cannot lose)

If favorite odds are below 1.40 AND team is near certain to not lose:
→ Pick H1 ⭐ BANKER (absolute certainty, safest pick)

BANKER RULE: Only banker=true if odds below 1.60 AND prob 80%+ AND all filters pass.
Never force bankers. Quality over quantity. 2-3 real bankers beat 7 forced ones.

SKIP any match where odds are outside 1.35 to 2.60 range.

Reply ONLY with valid JSON (no markdown, no extra text):
{"fav":"exact team name","h":"H2","prob":78,"banker":false,"odds":2.10,"hf":"WWWDW","af":"LLDLL","h2h":"6W-2D-2L","tips":["Team in great form","Opponent weak away","H2H dominance"],"writeup":"Liverpool start this match with a 2-goal advantage. They are currently 2nd in the Premier League with 4 wins in their last 5, while Brighton have won just 1 of their last 5 at home. Liverpool have not lost to Brighton in their last 6 meetings. This handicap gives them a massive cushion — they simply need to avoid losing by 2 or more goals."}

If match fails ANY rule above, reply ONLY: {"skip":true}`;

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
      writeup: ai.writeup || '',
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

// ── AUTO RESULT CHECKER ───────────────────────────────────────
async function checkResults() {
  console.log('[Results] Checking match results...');
  if (!FOOTBALL_KEY) { console.log('[Results] No API key'); return; }

  const db = load();
  const pending = db.predictions.filter(p => p.status === 'pending');
  if (!pending.length) { console.log('[Results] No pending predictions'); return; }

  // Get unique leagues from pending predictions
  const leagues = [...new Set(pending.map(p => p.league))];
  let updated = 0;

  for (const leagueName of leagues) {
    const league = LEAGUES.find(l => l.name === leagueName);
    if (!league) continue;

    try {
      // Fetch finished matches from last 3 days
      const url = `https://api.football-data.org/v4/competitions/${league.code}/matches?status=FINISHED`;
      const res = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_KEY } });
      if (!res.ok) continue;
      const data = await res.json();
      const finished = data.matches || [];

      for (const pred of pending.filter(p => p.league === leagueName)) {
        // Only check matches that should be finished (date is today or earlier)
        const matchDate = new Date(pred.date);
        const now = new Date();
        const hoursSinceMatch = (now - matchDate) / 3600000;
        if (hoursSinceMatch < 2) continue; // Too early, match may not be done

        // Find matching finished game by team name
        const match = finished.find(m => {
          const mHome = (m.homeTeam.shortName || m.homeTeam.name || '').toLowerCase();
          const mAway = (m.awayTeam.shortName || m.awayTeam.name || '').toLowerCase();
          const pHome = pred.home_team.toLowerCase();
          const pAway = pred.away_team.toLowerCase();
          // Match by first word of team name for flexibility
          const homeMatch = mHome.includes(pHome.split(' ')[0]) || pHome.includes(mHome.split(' ')[0]);
          const awayMatch = mAway.includes(pAway.split(' ')[0]) || pAway.includes(mAway.split(' ')[0]);
          return homeMatch && awayMatch;
        });

        if (!match || !match.score?.fullTime) continue;

        const homeScore = match.score.fullTime.home;
        const awayScore = match.score.fullTime.away;
        if (homeScore === null || awayScore === null) continue;

        // Determine if bet WON or LOST based on European Handicap
        // H1: favorite starts +1 up → wins unless LOSE the match
        // H2: favorite starts +2 up → wins unless lose by 2+
        // H3: favorite starts +3 up → wins unless lose by 3+
        const favIsHome = pred.favorite.toLowerCase().includes(pred.home_team.toLowerCase().split(' ')[0]) ||
                          pred.home_team.toLowerCase().includes(pred.favorite.toLowerCase().split(' ')[0]);
        const favScore = favIsHome ? homeScore : awayScore;
        const oppScore = favIsHome ? awayScore : homeScore;
        const margin = favScore - oppScore; // positive = fav winning

        let result;
        if (pred.handicap === 'H1') {
          // Fav starts +1 → loses only if they LOSE the actual match (margin < 0)
          result = margin >= 0 ? 'win' : 'loss';
        } else if (pred.handicap === 'H2') {
          // Fav starts +2 → loses only if they lose by 2+ (margin <= -2)
          result = margin >= -1 ? 'win' : 'loss';
        } else if (pred.handicap === 'H3') {
          // Fav starts +3 → loses only if they lose by 3+ (margin <= -3)
          result = margin >= -2 ? 'win' : 'loss';
        }

        // Update prediction
        const idx = db.predictions.findIndex(p => p.match_id === pred.match_id);
        if (idx > -1) {
          db.predictions[idx].status = result;
          db.predictions[idx].home_score = homeScore;
          db.predictions[idx].away_score = awayScore;
          updated++;
          console.log(`[Results] ${pred.home_team} ${homeScore}-${awayScore} ${pred.away_team} → ${pred.handicap_label} → ${result.toUpperCase()}`);
        }
      }
    } catch(err) {
      console.error(`[Results] ${leagueName}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  if (updated > 0) save(db);
  console.log(`[Results] Updated ${updated} predictions.`);
}

// Check results every 2 hours
cron.schedule('0 */2 * * *', checkResults);


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

// Manual result check trigger
app.get('/api/check-results', async (req, res) => {
  console.log('[Trigger] Manual result check triggered');
  try {
    await checkResults();
    const db = load();
    const settled = db.predictions.filter(p => p.status !== 'pending');
    res.json({ success:true, message:`Results checked! ${settled.length} settled predictions.` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Manually trigger result check
app.post('/api/check-results', async (req, res) => {
  try {
    await checkResults();
    res.json({ success:true, message:'Results checked and updated!' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Seed with real fixtures for this weekend
app.get('/api/seed', (req, res) => {
  const db = load();
  const d0 = new Date().toISOString().split('T')[0];
  const d1 = new Date(Date.now()+86400000).toISOString().split('T')[0];
  const d2 = new Date(Date.now()+172800000).toISOString().split('T')[0];
  const seeds = [
    // ── TODAY Mar 20 ─────────────────────────────────────────
    // MUN odds ~1.90 + good form → H2
    {match_id:'bou_mun',date:d0,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'AFC Bournemouth',away_team:'Manchester United',favorite:'Manchester United',handicap:'H2',handicap_label:'Man United H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:74,is_banker:0,bookmaker:'Bet9ja',odds:1.90,status:'pending',home_form:'LWDLL',away_form:'WWDLW',h2h_summary:'MUN 5W last 8',insights:['Away side stronger','United good form','Bournemouth inconsistent'],match_time:'21:00',writeup:"Man United start this match already leading 2-0. They have won 5 of the last 8 meetings with Bournemouth and are in solid away form. Bournemouth have been inconsistent at home, winning just 2 of their last 5. United simply need to avoid losing by 2 or more goals — a very comfortable cushion."},
    // RBL odds ~1.55 + dominant → H1 banker
    {match_id:'rbl_tsg',date:d0,league:'Bundesliga',league_flag:'🇩🇪',home_team:'RB Leipzig',away_team:'TSG Hoffenheim',favorite:'RB Leipzig',handicap:'H1',handicap_label:'RB Leipzig H1',win_condition:'Starts +1 up, wins unless they lose',probability:83,is_banker:1,bookmaker:'Bet9ja',odds:1.55,status:'pending',home_form:'WWWDW',away_form:'LLDLL',h2h_summary:'RBL 6W last 8 home',insights:['🔥 Leipzig sharp','Hoffenheim away poor','High scoring games'],match_time:'20:30',writeup:"RB Leipzig start with a 1-goal head start. They have won 6 of their last 8 at home and Hoffenheim have lost 4 of their last 5 away games. Leipzig are one of the highest scoring home sides in the Bundesliga. They cannot lose this match."},
    // Lens odds ~1.55 + dominant → H1 banker
    {match_id:'rcl_ang',date:d0,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Racing Club De Lens',away_team:'Angers SCO',favorite:'Racing Club De Lens',handicap:'H1',handicap_label:'Lens H1',win_condition:'Starts +1 up, wins unless they lose',probability:82,is_banker:1,bookmaker:'1xBet',odds:1.55,status:'pending',home_form:'WWWDW',away_form:'LLLLL',h2h_summary:'RCL 5W last 7 home',insights:['🔥 Lens dominant','Angers bottom','Strong home form'],match_time:'20:45',writeup:"Lens start this match already 1-0 up. Angers are bottom of Ligue 1 with 5 consecutive away defeats. Lens have won their last 5 at home and are one of the most dominant sides in the division. The head start makes this extremely safe."},
    // ── MAR 21 ───────────────────────────────────────────────
    // Liverpool odds ~2.00 + good form → H2
    {match_id:'bri_liv',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Brighton',away_team:'Liverpool',favorite:'Liverpool',handicap:'H2',handicap_label:'Liverpool H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:78,is_banker:0,bookmaker:'Bet9ja',odds:2.00,status:'pending',home_form:'DWLDD',away_form:'WWWDW',h2h_summary:'LIV 6W last 9',insights:['Liverpool title charge','Brighton solid home','Away side stronger'],match_time:'13:30',writeup:"Liverpool enter this match with a 2-goal advantage before kickoff. They have won 6 of the last 9 meetings with Brighton and are in top 2 form in the league. Brighton have only won 1 of their last 5 at home. Liverpool need to simply not lose by 2 — very achievable for a team of their quality."},
    // Fulham odds ~1.50 + very dominant → H1 banker
    {match_id:'ful_bur',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Fulham',away_team:'Burnley',favorite:'Fulham',handicap:'H1',handicap_label:'Fulham H1',win_condition:'Starts +1 up, wins unless they lose',probability:84,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'FUL 5W last 6 home',insights:['🔥 Home dominant','Burnley bottom 3','Avg 3.1 goals'],match_time:'16:00',writeup:"Fulham start already winning 1-0. They are dominant at home, winning 5 of their last 6 there, scoring an average of 3.1 goals per game. Burnley sit bottom 3 and have lost 4 of their last 5 away. Fulham simply cannot lose this match."},
    // Chelsea odds ~2.05 + good form → H2
    {match_id:'eve_che',date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Everton',away_team:'Chelsea',favorite:'Chelsea',handicap:'H2',handicap_label:'Chelsea H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:76,is_banker:0,bookmaker:'Betway',odds:2.05,status:'pending',home_form:'LLDLL',away_form:'WWWLW',h2h_summary:'CHE 4W last 6',insights:['Chelsea in form','Everton relegation zone','Strong away record'],match_time:'18:30',writeup:"Chelsea start this match 2-0 ahead. Everton are in the relegation zone with no wins in their last 5 at home. Chelsea have won 4 of the last 6 meetings and are in strong form. A 2-goal head start against a struggling Everton side is a very safe position."},
    // Bayern odds ~1.40 + most dominant → H1 banker
    {match_id:'bmu_uni',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Bayern Munich',away_team:'Union Berlin',favorite:'Bayern Munich',handicap:'H1',handicap_label:'Bayern H1',win_condition:'Starts +1 up, wins unless they lose',probability:87,is_banker:1,bookmaker:'Bet9ja',odds:1.40,status:'pending',home_form:'WWWDW',away_form:'LLLLL',h2h_summary:'BAY 9W last 10 home',insights:['🔥 Bayern unstoppable','Union Berlin bottom','Kane in top form'],match_time:'15:30',writeup:"Bayern Munich start already 1-0 up. They have won 9 of their last 10 home games and Union Berlin are bottom of the Bundesliga with 5 consecutive losses. Harry Kane is in top scoring form. This is one of the safest handicap picks on the card."},
    // Dortmund odds ~2.00 + good form → H2
    {match_id:'bvb_hsv',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Borussia Dortmund',away_team:'Hamburger SV',favorite:'Borussia Dortmund',handicap:'H2',handicap_label:'Dortmund H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:76,is_banker:0,bookmaker:'Betway',odds:2.00,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'BVB 5W last 7 home',insights:['Dortmund strong home','HSV newly promoted','Signal Iduna atmosphere'],match_time:'18:30',writeup:"Dortmund enter with a 2-goal cushion. HSV are newly promoted and have lost 4 of their last 5 away games. Dortmund are dominant at Signal Iduna Park and have won 5 of their last 7 at home. They need to simply not lose by 2 — very comfortable."},
    // Leverkusen odds ~2.10 + good form away → H2
    {match_id:'fch_lev',date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'1. FC Heidenheim',away_team:'Bayer Leverkusen',favorite:'Bayer Leverkusen',handicap:'H2',handicap_label:'Leverkusen H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:75,is_banker:0,bookmaker:'1xBet',odds:2.10,status:'pending',home_form:'LLDLL',away_form:'WWWDW',h2h_summary:'LEV 5W last 7',insights:['Leverkusen title push','Heidenheim struggling','Away side dominant'],match_time:'15:30',writeup:"Leverkusen start 2 goals ahead. They are pushing for the Bundesliga title and have won 5 of their last 7 away games. Heidenheim are struggling near the bottom and have lost at home recently. The away side are clearly superior here."},
    // AC Milan odds ~1.80 + good form → H2
    {match_id:'acm_tor',date:d1,league:'Serie A',league_flag:'🇮🇹',home_team:'AC Milan',away_team:'Torino FC',favorite:'AC Milan',handicap:'H2',handicap_label:'AC Milan H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:78,is_banker:0,bookmaker:'Bet9ja',odds:1.80,status:'pending',home_form:'WWWDL',away_form:'LLDLL',h2h_summary:'MIL 5W last 7 home',insights:['Milan top 4 push','Torino poor away','San Siro advantage'],match_time:'18:00',writeup:"AC Milan start 2 goals ahead. They have won 5 of their last 7 home games and Torino have lost 4 of their last 5 away. Milan are chasing a top 4 spot and have the motivation. The 2-goal head start at San Siro makes this a very calculated pick."},
    // Juventus odds ~1.50 + very dominant → H1 banker
    {match_id:'juv_sas',date:d1,league:'Serie A',league_flag:'🇮🇹',home_team:'Juventus Turin',away_team:'Sassuolo Calcio',favorite:'Juventus Turin',handicap:'H1',handicap_label:'Juventus H1',win_condition:'Starts +1 up, wins unless they lose',probability:83,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'JUV 5W last 6 home',insights:['🔥 Juve home record','Sassuolo poor away','Clean sheet streak'],match_time:'20:45',writeup:"Juventus start already 1-0 up against Sassuolo. Juve have won 5 of their last 6 home games with a clean sheet run. Sassuolo are poor away with just 1 win in their last 7 road trips. This is Juventus at home — they simply do not lose."},
    // PSG odds ~1.50 + dominant → H1 banker
    {match_id:'nic_psg',date:d1,league:'Ligue 1',league_flag:'🇫🇷',home_team:'OGC Nice',away_team:'Paris Saint-Germain',favorite:'Paris Saint-Germain',handicap:'H1',handicap_label:'PSG H1',win_condition:'Starts +1 up, wins unless they lose',probability:82,is_banker:1,bookmaker:'Bet9ja',odds:1.50,status:'pending',home_form:'WDLDD',away_form:'WWWWL',h2h_summary:'PSG 6W last 8 away',insights:['🔥 PSG dominant','Nice mid-table','Away side superior'],match_time:'21:05',writeup:"PSG travel to Nice with a 1-goal head start already banked. PSG have won 6 of their last 8 away games and Nice sit mid-table. PSG are the most dominant team in Ligue 1 and losing away is almost unthinkable for them this season."},
    // ── MAR 22 ───────────────────────────────────────────────
    // Newcastle odds ~1.55 + dominant home → H1 banker
    {match_id:'new_sun',date:d2,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Newcastle United',away_team:'Sunderland',favorite:'Newcastle United',handicap:'H1',handicap_label:'Newcastle H1',win_condition:'Starts +1 up, wins unless they lose',probability:80,is_banker:1,bookmaker:'Bet9ja',odds:1.55,status:'pending',home_form:'WWWDW',away_form:'LWLLD',h2h_summary:'NEW 5W last 7 home',insights:['Tyne-Wear Derby','Newcastle top 4 push','Sunderland away poor'],match_time:'14:00',writeup:"Newcastle start 1 goal ahead in the Tyne-Wear Derby. They have won 5 of their last 7 home games and Sunderland have won just 1 away all season. Newcastle are pushing for top 4 and have full motivation. The head start makes this extremely low risk."},
    // Aston Villa odds ~1.90 + good form → H2
    {match_id:'avl_whu',date:d2,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Aston Villa',away_team:'West Ham',favorite:'Aston Villa',handicap:'H2',handicap_label:'Aston Villa H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:74,is_banker:0,bookmaker:'1xBet',odds:1.90,status:'pending',home_form:'WWWLW',away_form:'DLWLL',h2h_summary:'AVL 4W last 6',insights:['Villa European chase','West Ham inconsistent','Strong home crowd'],match_time:'16:15',writeup:"Aston Villa start 2 goals ahead. They are chasing European football and have won 3 of their last 5 at home. West Ham have been inconsistent, winning just 1 of their last 5 away. With a 2-goal head start Villa need to simply not lose by 2 — very achievable."},
    // Tottenham odds ~1.95 + good form → H2
    {match_id:'tot_nfo',date:d2,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Tottenham',away_team:'Nottm Forest',favorite:'Tottenham',handicap:'H2',handicap_label:'Tottenham H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:72,is_banker:0,bookmaker:'Betway',odds:1.95,status:'pending',home_form:'WWDWL',away_form:'WDLLL',h2h_summary:'TOT 4W last 7',insights:['Spurs home bounce','Forest travel badly','Top 4 battle'],match_time:'16:15',writeup:"Tottenham start with a 2-goal advantage. Forest have lost 3 of their last 5 away games and struggle to score on the road. Spurs at home with a 2-goal cushion is a comfortable position — they need to avoid a 2-goal defeat which is very unlikely."},
    // Barcelona odds ~1.40 + most dominant → H1 banker
    {match_id:'bar_rvc',date:d2,league:'La Liga',league_flag:'🇪🇸',home_team:'FC Barcelona',away_team:'Rayo Vallecano',favorite:'FC Barcelona',handicap:'H1',handicap_label:'Barcelona H1',win_condition:'Starts +1 up, wins unless they lose',probability:88,is_banker:1,bookmaker:'Bet9ja',odds:1.40,status:'pending',home_form:'WWWWW',away_form:'LLLDD',h2h_summary:'BAR 8W last 10 home',insights:['🔥 Barca 5 game streak','Rayo away terrible','Avg 3.6 goals at home'],match_time:'14:00',writeup:"Barcelona start already 1-0 up against Rayo Vallecano. Barca are on a 5-game winning streak and have won 8 of their last 10 at home. Rayo have lost all 5 of their recent away games and average under 1 goal per game on the road. This is as safe as a banker gets."},
    // Real Madrid odds ~2.05 + good form → H2
    {match_id:'rma_atm',date:d2,league:'La Liga',league_flag:'🇪🇸',home_team:'Real Madrid',away_team:'Atletico Madrid',favorite:'Real Madrid',handicap:'H2',handicap_label:'Real Madrid H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:73,is_banker:0,bookmaker:'Bet9ja',odds:2.05,status:'pending',home_form:'WWDWW',away_form:'WDWLW',h2h_summary:'RMA 5W last 8 home',insights:['Madrid home fortress','El Derbi tension','Title race crunch'],match_time:'21:00',writeup:"Real Madrid start 2 goals ahead in the El Derbi. Madrid have won 5 of their last 8 home derbies and are in strong form. With a 2-goal head start even a draw or 1-goal defeat counts as a win for this bet. A very calculated pick in a high-stakes match."},
    // Como odds ~1.55 + strong home → H1 banker
    {match_id:'com_pis',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'Como 1907',away_team:'Pisa SC',favorite:'Como 1907',handicap:'H1',handicap_label:'Como H1',win_condition:'Starts +1 up, wins unless they lose',probability:80,is_banker:1,bookmaker:'Betway',odds:1.55,status:'pending',home_form:'WWWDL',away_form:'LLDLL',h2h_summary:'COM 5W last 7 home',insights:['Como strong home','Pisa away poor','Home dominance'],match_time:'12:30',writeup:"Como start 1 goal ahead at home. They have won 5 of their last 7 home games and Pisa have lost away consistently. Como are a well-organised home side and simply do not lose at their ground — the head start makes this extremely safe."},
    // Atalanta odds ~1.50 + dominant → H1 banker
    {match_id:'ata_ver',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'Atalanta BC',away_team:'Hellas Verona',favorite:'Atalanta BC',handicap:'H1',handicap_label:'Atalanta H1',win_condition:'Starts +1 up, wins unless they lose',probability:80,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWWL',away_form:'LLLLL',h2h_summary:'ATA 6W last 8 home',insights:['Atalanta top form','Verona relegated zone','Goals machine'],match_time:'15:00',writeup:"Atalanta start 1 goal ahead against relegated-threatened Verona. Atalanta have won 6 of their last 8 at home and are one of the most prolific attacks in Serie A. Verona have lost 5 consecutive away games. A 1-goal head start for Atalanta is close to a guaranteed win."},
    // Inter odds ~2.00 + good form away → H2
    {match_id:'fio_int',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'ACF Fiorentina',away_team:'Inter Milano',favorite:'Inter Milano',handicap:'H2',handicap_label:'Inter H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:74,is_banker:0,bookmaker:'Bet9ja',odds:2.00,status:'pending',home_form:'WWLWW',away_form:'WWWDW',h2h_summary:'INT 5W last 8',insights:['Inter title chasing','Fiorentina strong home','Away side quality'],match_time:'20:45',writeup:"Inter start 2 goals ahead away at Fiorentina. Inter are title-chasing and have won 5 of their last 8 away games. With a 2-goal cushion, Inter need to avoid a loss by 2 or more. Given their quality and title motivation, this is a very solid pick."},
    // Roma odds ~1.82 + good form → H2
    {match_id:'rom_lec',date:d2,league:'Serie A',league_flag:'🇮🇹',home_team:'AS Roma',away_team:'US Lecce',favorite:'AS Roma',handicap:'H2',handicap_label:'Roma H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:76,is_banker:0,bookmaker:'Betway',odds:1.82,status:'pending',home_form:'WWDWL',away_form:'LLLDD',h2h_summary:'ROM 5W last 7 home',insights:['Roma home fortress','Lecce relegation battle','Olimpico pressure'],match_time:'18:00',writeup:"Roma start 2 goals ahead at home to Lecce. Roma have won 5 of their last 7 at the Olimpico and Lecce are fighting relegation with just 2 away wins all season. A 2-goal head start for Roma at home makes this a high-confidence selection."},
    // Rennes odds ~1.50 + dominant → H1 banker
    {match_id:'ren_fcm',date:d2,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Stade Rennais FC',away_team:'FC Metz',favorite:'Stade Rennais FC',handicap:'H1',handicap_label:'Rennes H1',win_condition:'Starts +1 up, wins unless they lose',probability:82,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'REN 6W last 8 home',insights:['🔥 Rennes dominant','Metz bottom 3','Home goal machine'],match_time:'16:15',writeup:"Rennes start 1 goal up at home to Metz. Rennes have won 6 of their last 8 at home and Metz sit in the bottom 3 with 4 consecutive away losses. Rennes are one of the most reliable home sides in Ligue 1. They simply cannot lose here."},
    // Marseille odds ~1.95 + good form → H2
    {match_id:'olm_lil',date:d2,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Olympique Marseille',away_team:'Lille OSC',favorite:'Olympique Marseille',handicap:'H2',handicap_label:'Marseille H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:73,is_banker:0,bookmaker:'Bet9ja',odds:1.95,status:'pending',home_form:'WWWLL',away_form:'WDLWL',h2h_summary:'OLM 4W last 7 home',insights:['Marseille Velodrome','Lille good form','Tight contest'],match_time:'16:15',writeup:"Marseille start 2 goals ahead at the Vélodrome. Marseille have won 3 of their last 5 at home and Lille, while strong, have struggled on the road recently. The 2-goal head start means Marseille only lose this bet if they are beaten by 2 or more — very unlikely at home."},
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
