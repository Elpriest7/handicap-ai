const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || '';
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';

const LEAGUES = [
  { code:'PL',  name:'Premier League', flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿', apiId:39  },
  { code:'PD',  name:'La Liga',        flag:'🇪🇸',        apiId:140 },
  { code:'SA',  name:'Serie A',        flag:'🇮🇹',        apiId:135 },
  { code:'BL1', name:'Bundesliga',     flag:'🇩🇪',        apiId:78  },
  { code:'FL1', name:'Ligue 1',        flag:'🇫🇷',        apiId:61  },
];

// ── MONGODB ───────────────────────────────────────────────────
let col = null;
async function getCol() {
  if (col) return col;
  if (!MONGODB_URI) { console.log('[DB] No MONGODB_URI'); return null; }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    col = client.db('handicapai').collection('predictions');
    console.log('✅ MongoDB connected');
    return col;
  } catch(e) { console.error('❌ MongoDB:', e.message); return null; }
}

async function dbLoad() {
  const c = await getCol();
  if (!c) return [];
  return await c.find({}).toArray();
}

async function dbUpsert(pred) {
  const c = await getCol();
  if (!c) return;
  await c.updateOne({ match_id: pred.match_id }, { $set: pred }, { upsert: true });
}

async function dbUpdateResult(match_id, status, home_score, away_score) {
  const c = await getCol();
  if (!c) return;
  await c.updateOne({ match_id }, { $set: { status, home_score, away_score } });
}

async function dbDeleteOld(cutoff) {
  const c = await getCol();
  if (!c) return;
  await c.deleteMany({ date: { $lt: cutoff } });
}

async function dbClearAll() {
  const c = await getCol();
  if (!c) return;
  await c.deleteMany({});
}

// ── FETCH FIXTURES ────────────────────────────────────────────
async function fetchFixtures() {
  if (!FOOTBALL_KEY) return [];
  const today = new Date().toISOString().split('T')[0];
  const threeDays = new Date(Date.now()+3*86400000).toISOString().split('T')[0];
  const all = [];
  for (const lg of LEAGUES) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${lg.code}/matches?dateFrom=${today}&dateTo=${threeDays}&status=SCHEDULED`;
      const r = await fetch(url, { headers:{'X-Auth-Token':FOOTBALL_KEY} });
      if (!r.ok) continue;
      const d = await r.json();
      (d.matches||[]).forEach(m => all.push({
        id:`fd_${m.id}`, h:m.homeTeam.shortName||m.homeTeam.name,
        a:m.awayTeam.shortName||m.awayTeam.name, lg:lg.name, fl:lg.flag,
        dt:m.utcDate.split('T')[0], tm:m.utcDate.substring(11,16)
      }));
    } catch(e) { console.error('[Fixtures]', lg.code, e.message); }
    await new Promise(r=>setTimeout(r,500));
  }
  return all;
}

// ── GEMINI ────────────────────────────────────────────────────
async function askGemini(home, away, league) {
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `You are a strict European Handicap betting analyst. Analyze: ${home} vs ${away} (${league}).

HOW EUROPEAN HANDICAP WORKS:
The FAVORITE gets a goal head start BEFORE the match.
- H1 = Favorite starts +1 up. Wins if they do NOT lose.
- H2 = Favorite starts +2 up. Wins unless they lose by 2+.
- H3 = Favorite starts +3 up. Wins unless they lose by 3+.
H3 is SAFER than H1. H1 requires most confidence.

SKIP if ANY apply:
❌ Favorite lost 3+ of last 5
❌ Opponent is defensively strong
❌ Match is unpredictable
❌ Favorite inconsistent or poor form
❌ Low motivation match
❌ High chance of upset

ONLY PICK if ALL apply:
✅ Favorite wins frequently, rarely loses
✅ Won at least 3 of last 5
✅ Opponent weak or poor form
✅ H2H strongly favors favorite
✅ Probability 70%+

HANDICAP BASED ON ODDS:
- Odds 1.80-2.50: Pick H2 or H3 (big head start = safe even if close)
- Odds 1.40-1.79: Pick H1 (so dominant they simply cannot lose)
- Odds below 1.40: Pick H1 BANKER (near certain)

BANKER: Only if odds below 1.60 AND prob 80%+. Max 2-3 bankers per day.

Reply ONLY valid JSON:
{"fav":"team name","h":"H2","prob":78,"banker":false,"odds":2.10,"hf":"WWWDW","af":"LLDLL","h2h":"6W-2D-2L","tips":["reason1","reason2","reason3"],"writeup":"2-3 sentence explanation why this pick is safe"}

If fails ANY rule: {"skip":true}`;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1,maxOutputTokens:250} })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.[0]?.text||'';
    const s=txt.indexOf('{'), e=txt.lastIndexOf('}');
    if(s<0||e<0) return null;
    const j=JSON.parse(txt.slice(s,e+1));
    if(j.skip||!j.prob||j.prob<70) return null;
    if(j.odds&&j.odds<1.35) return null;
    j.banker = j.prob>=80 && j.odds<=1.60;
    return j;
  } catch(e) { console.log('[Gemini]',e.message); return null; }
}

// ── DAILY UPDATE ──────────────────────────────────────────────
async function runDailyUpdate() {
  console.log('[CRON] Daily update starting...');
  const existing = await dbLoad();
  const existingIds = new Set(existing.map(p=>p.match_id));
  const fixtures = await fetchFixtures();
  let added = 0;
  for (const f of fixtures) {
    if (existingIds.has(f.id)) continue;
    const ai = await askGemini(f.h, f.a, f.lg);
    if (!ai) continue;
    const hcap = ai.h||'H1';
    const fav = ai.fav||f.h;
    const pred = {
      match_id:f.id, date:f.dt, league:f.lg, league_flag:f.fl,
      home_team:f.h, away_team:f.a, favorite:fav, handicap:hcap,
      handicap_label:`${fav} ${hcap}`,
      win_condition:hcap==='H1'?'Starts +1 up, wins unless they lose':hcap==='H2'?'Starts +2 up, wins unless lose by 2+':'Starts +3 up, wins unless lose by 3+',
      probability:ai.prob, is_banker:(ai.banker?1:0), bookmaker:'Bet9ja',
      odds:ai.odds||1.75, status:'pending', home_score:null, away_score:null,
      home_form:ai.hf||'WWDLW', away_form:ai.af||'LWLLL',
      h2h_summary:ai.h2h||'', insights:ai.tips||[], writeup:ai.writeup||'',
      match_time:f.tm, created_at:new Date().toISOString()
    };
    await dbUpsert(pred);
    added++;
    console.log(`[+] ${fav} ${hcap} ${ai.prob}% — ${f.h} vs ${f.a}`);
    await new Promise(r=>setTimeout(r,1200));
  }
  console.log(`[CRON] Done. Added ${added}.`);
  return added;
}

// ── CHECK RESULTS ─────────────────────────────────────────────
async function checkResults() {
  console.log('[Results] Checking...');
  if (!APIFOOTBALL_KEY) return;
  const all = await dbLoad();
  const pending = all.filter(p=>p.status==='pending');
  if (!pending.length) { console.log('[Results] No pending'); return; }
  const leagues = [...new Set(pending.map(p=>p.league))];
  let updated=0;
  for (const lgName of leagues) {
    const lg = LEAGUES.find(l=>l.name===lgName);
    if (!lg||!lg.apiId) continue;
    try {
      const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];
      // Use football-data.org — supports current 2026 season
      const url = `https://api.football-data.org/v4/competitions/${lg.code}/matches?dateFrom=${yesterday}&dateTo=${today}&status=FINISHED`;
      const r = await fetch(url, { headers:{'X-Auth-Token': FOOTBALL_KEY} });
      if (!r.ok) { console.log(`[Results] ${lg.code} error:`, r.status); continue; }
      const d = await r.json();
      const finished = d.matches || [];
      console.log(`[Results] ${lgName}: ${finished.length} finished matches`);
      for (const pred of pending.filter(p=>p.league===lgName)) {
        const minsSince = (new Date()-new Date(pred.date))/60000;
        if (minsSince<20) continue;
        const fix = finished.find(f=>{
          const mH=(f.homeTeam?.shortName||f.homeTeam?.name||'').toLowerCase();
          const mA=(f.awayTeam?.shortName||f.awayTeam?.name||'').toLowerCase();
          const pH=pred.home_team.toLowerCase();
          const pA=pred.away_team.toLowerCase();
          const homeMatch = mH.includes(pH.split(' ')[0]) || pH.includes(mH.split(' ')[0]);
          const awayMatch = mA.includes(pA.split(' ')[0]) || pA.includes(mA.split(' ')[0]);
          return homeMatch && awayMatch;
        });
        if (!fix) continue;
        // football-data.org score format
        const hs = fix.score?.fullTime?.home ?? fix.goals?.home;
        const as2 = fix.score?.fullTime?.away ?? fix.goals?.away;
        if (hs===null||hs===undefined||as2===null||as2===undefined) continue;
        const favIsHome = pred.home_team.toLowerCase().includes(pred.favorite.toLowerCase().split(' ')[0])||
                          pred.favorite.toLowerCase().includes(pred.home_team.toLowerCase().split(' ')[0]);
        const favScore = favIsHome ? hs : as2;
        const oppScore = favIsHome ? as2 : hs;
        const margin = favScore - oppScore;
        let result;
        if(pred.handicap==='H1') result=margin>=0?'win':'loss';
        else if(pred.handicap==='H2') result=margin>=-1?'win':'loss';
        else result=margin>=-2?'win':'loss';
        await dbUpdateResult(pred.match_id, result, hs, as2);
        updated++;
        console.log(`[Results] ✅ ${pred.home_team} ${hs}-${as2} ${pred.away_team} → ${pred.handicap_label} → ${result.toUpperCase()}`);
      }
    } catch(e) { console.error('[Results]',lgName,e.message); }
    await new Promise(r=>setTimeout(r,600));
  }
  console.log(`[Results] Updated ${updated}`);
  return updated;
}

// ── MIDNIGHT ROLLOVER ─────────────────────────────────────────
async function midnightRollover() {
  console.log('[Rollover] Starting...');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
  const all = await dbLoad();
  for (const p of all) {
    if (p.date<=yesterday && p.status==='pending') {
      await dbUpdateResult(p.match_id,'expired',null,null);
    }
  }
  // Keep max 60 days
  const cutoff = new Date(Date.now()-60*86400000).toISOString().split('T')[0];
  await dbDeleteOld(cutoff);
  await runDailyUpdate();
  console.log('[Rollover] Done');
}

// ── CRON SCHEDULES ────────────────────────────────────────────
cron.schedule('0 7 * * *', runDailyUpdate);
cron.schedule('1 0 * * *', midnightRollover);
cron.schedule('*/20 * * * *', checkResults);

// ── ROUTES ────────────────────────────────────────────────────
app.get('/api/predictions', async (req,res) => {
  const { date, league='all', min_prob='70' } = req.query;
  const day = date||new Date().toISOString().split('T')[0];
  let list = await dbLoad();
  list = list.filter(p=>
    p.date===day &&
    p.probability>=(parseInt(min_prob)||70) &&
    (league==='all'||p.league===league)
  );
  list.sort((a,b)=>b.is_banker-a.is_banker||b.probability-a.probability);
  res.json({ success:true, date:day, count:list.length, predictions:list });
});

app.get('/api/stats', async (req,res) => {
  const today = new Date().toISOString().split('T')[0];
  const all = await dbLoad();
  const tp = all.filter(p=>p.date===today);
  const done = all.filter(p=>p.status==='win'||p.status==='loss');
  const wins = done.filter(p=>p.status==='win').length;
  res.json({
    today_picks:tp.length, today_bankers:tp.filter(p=>p.is_banker).length,
    win_rate:done.length?Math.round(wins/done.length*100):0,
    avg_prob:tp.length?Math.round(tp.reduce((s,p)=>s+p.probability,0)/tp.length):0,
    total_predictions:done.length
  });
});

app.get('/api/history', async (req,res) => {
  const all = await dbLoad();
  const h = all.filter(p=>p.status!=='pending').sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,50);
  res.json({ success:true, history:h });
});

app.get('/api/analytics', async (req,res) => {
  const all = await dbLoad();
  const done = all.filter(p=>p.status==='win'||p.status==='loss');
  const lm = {};
  done.forEach(p=>{
    if(!lm[p.league]) lm[p.league]={league:p.league,league_flag:p.league_flag,total:0,wins:0};
    lm[p.league].total++;
    if(p.status==='win') lm[p.league].wins++;
  });
  const bl = Object.values(lm).map(l=>({...l,win_rate:l.total?Math.round(l.wins/l.total*100):0})).sort((a,b)=>b.win_rate-a.win_rate);
  const bk = done.filter(p=>p.is_banker);
  res.json({ by_league:bl, banker_rate:bk.length?Math.round(bk.filter(p=>p.status==='win').length/bk.length*100):0, banker_total:bk.length });
});

app.post('/api/trigger', async (req,res) => {
  try { const n=await runDailyUpdate(); res.json({success:true,message:`Added ${n} predictions`}); }
  catch(e) { res.status(500).json({success:false,message:e.message}); }
});

app.get('/api/check-results', async (req,res) => {
  try {
    const updated=await checkResults();
    const all=await dbLoad();
    const wins=all.filter(p=>p.status==='win').length;
    const losses=all.filter(p=>p.status==='loss').length;
    res.json({success:true,message:`Updated ${updated||0}. Total: ${wins}W ${losses}L`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// Fresh reseed — clears ALL and reloads with today's correct dates
app.get('/api/reseed', async (req,res) => {
  await dbClearAll();
  const dm1=new Date(Date.now()-86400000).toISOString().split('T')[0];
  const d0=new Date().toISOString().split('T')[0];
  const d1=new Date(Date.now()+86400000).toISOString().split('T')[0];
  console.log(`[Reseed] Yesterday=${dm1} Today=${d0} Tomorrow=${d1}`);

  const seeds=[
    // ── YESTERDAY ────────────────────────────────────────────
    {match_id:`y_bri_liv`,date:dm1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Brighton',away_team:'Liverpool',favorite:'Liverpool',handicap:'H2',handicap_label:'Liverpool H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:78,is_banker:0,bookmaker:'Bet9ja',odds:2.00,status:'pending',home_form:'DWLDD',away_form:'WWWDW',h2h_summary:'LIV 6W last 9',insights:['Liverpool title charge','Brighton solid home','Away side stronger'],match_time:'13:30',writeup:"Liverpool start 2 goals up. Won 6 of last 9 vs Brighton. Need to avoid a 2-goal loss — very unlikely for a title-chasing team."},
    {match_id:`y_ful_bur`,date:dm1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Fulham',away_team:'Burnley',favorite:'Fulham',handicap:'H1',handicap_label:'Fulham H1',win_condition:'Starts +1 up, wins unless they lose',probability:84,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'FUL 5W last 6 home',insights:['🔥 Home dominant','Burnley bottom 3','Avg 3.1 goals'],match_time:'16:00',writeup:"Fulham start 1 goal up at home vs bottom-3 Burnley. Won 5 of last 6 at home. Burnley lost 4 of 5 away. Cannot lose this."},
    {match_id:`y_eve_che`,date:dm1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Everton',away_team:'Chelsea',favorite:'Chelsea',handicap:'H2',handicap_label:'Chelsea H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:76,is_banker:0,bookmaker:'Betway',odds:2.05,status:'pending',home_form:'LLDLL',away_form:'WWWLW',h2h_summary:'CHE 4W last 6',insights:['Chelsea in form','Everton relegation zone','Strong away record'],match_time:'18:30',writeup:"Chelsea start 2 goals up vs relegated-threatened Everton. Won 4 of last 6. Very comfortable position."},
    {match_id:`y_bmu_uni`,date:dm1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Bayern Munich',away_team:'Union Berlin',favorite:'Bayern Munich',handicap:'H1',handicap_label:'Bayern H1',win_condition:'Starts +1 up, wins unless they lose',probability:87,is_banker:1,bookmaker:'Bet9ja',odds:1.40,status:'pending',home_form:'WWWDW',away_form:'LLLLL',h2h_summary:'BAY 9W last 10 home',insights:['🔥 Bayern unstoppable','Union Berlin bottom','Kane in top form'],match_time:'15:30',writeup:"Bayern start 1 goal up vs bottom Union Berlin with 5 straight losses. Won 9 of last 10 at home. Safest pick on the card."},
    {match_id:`y_bvb_hsv`,date:dm1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'Borussia Dortmund',away_team:'Hamburger SV',favorite:'Borussia Dortmund',handicap:'H2',handicap_label:'Dortmund H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:76,is_banker:0,bookmaker:'Betway',odds:2.00,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'BVB 5W last 7 home',insights:['Dortmund strong home','HSV newly promoted','Signal Iduna atmosphere'],match_time:'18:30',writeup:"Dortmund start 2 goals up vs newly promoted HSV. Won 5 of last 7 at home. Very comfortable position."},
    {match_id:`y_nic_psg`,date:dm1,league:'Ligue 1',league_flag:'🇫🇷',home_team:'OGC Nice',away_team:'Paris Saint-Germain',favorite:'Paris Saint-Germain',handicap:'H1',handicap_label:'PSG H1',win_condition:'Starts +1 up, wins unless they lose',probability:82,is_banker:1,bookmaker:'Bet9ja',odds:1.50,status:'pending',home_form:'WDLDD',away_form:'WWWWL',h2h_summary:'PSG 6W last 8 away',insights:['🔥 PSG dominant','Nice mid-table','Away side superior'],match_time:'21:05',writeup:"PSG start 1 goal up away at Nice. Won 6 of last 8 away. Most dominant side in Ligue 1. Cannot lose."},
    {match_id:`y_juv_sas`,date:dm1,league:'Serie A',league_flag:'🇮🇹',home_team:'Juventus Turin',away_team:'Sassuolo Calcio',favorite:'Juventus Turin',handicap:'H1',handicap_label:'Juventus H1',win_condition:'Starts +1 up, wins unless they lose',probability:83,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWLW',away_form:'LLDLL',h2h_summary:'JUV 5W last 6 home',insights:['🔥 Juve home record','Sassuolo poor away','Clean sheet streak'],match_time:'20:45',writeup:"Juventus start 1 goal up at home vs Sassuolo. Won 5 of last 6 at home. Sassuolo have 1 win in last 7 away. Do not lose."},
    {match_id:`y_rbl_tsg`,date:dm1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'RB Leipzig',away_team:'TSG Hoffenheim',favorite:'RB Leipzig',handicap:'H1',handicap_label:'RB Leipzig H1',win_condition:'Starts +1 up, wins unless they lose',probability:83,is_banker:1,bookmaker:'Bet9ja',odds:1.55,status:'pending',home_form:'WWWDW',away_form:'LLDLL',h2h_summary:'RBL 6W last 8 home',insights:['🔥 Leipzig sharp','Hoffenheim away poor','High scoring games'],match_time:'20:30',writeup:"Leipzig start 1 goal up. Won 6 of last 8 at home. Hoffenheim lost 4 of last 5 away. Leipzig cannot lose this."},
    // ── TODAY ─────────────────────────────────────────────────
    {match_id:`t_bar_rvc`,date:d0,league:'La Liga',league_flag:'🇪🇸',home_team:'FC Barcelona',away_team:'Rayo Vallecano',favorite:'FC Barcelona',handicap:'H1',handicap_label:'Barcelona H1',win_condition:'Starts +1 up, wins unless they lose',probability:88,is_banker:1,bookmaker:'Bet9ja',odds:1.40,status:'pending',home_form:'WWWWW',away_form:'LLLDD',h2h_summary:'BAR 8W last 10 home',insights:['🔥 Barca 5 game streak','Rayo away terrible','Avg 3.6 goals at home'],match_time:'14:00',writeup:"Barcelona start 1 goal up vs Rayo who lost all 5 recent away. Barca on 5-game win streak. As safe as a banker gets."},
    {match_id:`t_rma_atm`,date:d0,league:'La Liga',league_flag:'🇪🇸',home_team:'Real Madrid',away_team:'Atletico Madrid',favorite:'Real Madrid',handicap:'H2',handicap_label:'Real Madrid H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:73,is_banker:0,bookmaker:'Bet9ja',odds:2.05,status:'pending',home_form:'WWDWW',away_form:'WDWLW',h2h_summary:'RMA 5W last 8 home',insights:['Madrid home fortress','El Derbi tension','Title race crunch'],match_time:'21:00',writeup:"Real Madrid start 2 goals up in El Derbi. Won 5 of last 8 home derbies. Even a 1-goal loss wins the bet."},
    {match_id:`t_new_sun`,date:d0,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Newcastle United',away_team:'Sunderland',favorite:'Newcastle United',handicap:'H1',handicap_label:'Newcastle H1',win_condition:'Starts +1 up, wins unless they lose',probability:80,is_banker:1,bookmaker:'Bet9ja',odds:1.55,status:'pending',home_form:'WWWDW',away_form:'LWLLD',h2h_summary:'NEW 5W last 7 home',insights:['Tyne-Wear Derby','Newcastle top 4 push','Sunderland away poor'],match_time:'14:00',writeup:"Newcastle start 1 goal up in the Tyne-Wear Derby. Won 5 of last 7 at home. Sunderland have just 1 away win all season."},
    {match_id:`t_avl_whu`,date:d0,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Aston Villa',away_team:'West Ham',favorite:'Aston Villa',handicap:'H2',handicap_label:'Aston Villa H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:74,is_banker:0,bookmaker:'1xBet',odds:1.90,status:'pending',home_form:'WWWLW',away_form:'DLWLL',h2h_summary:'AVL 4W last 6',insights:['Villa European chase','West Ham inconsistent','Strong home crowd'],match_time:'16:15',writeup:"Villa start 2 goals up vs inconsistent West Ham. Won 3 of last 5 at home. West Ham won just 1 of 5 away."},
    {match_id:`t_tot_nfo`,date:d0,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Tottenham',away_team:'Nottm Forest',favorite:'Tottenham',handicap:'H2',handicap_label:'Tottenham H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:72,is_banker:0,bookmaker:'Betway',odds:1.95,status:'pending',home_form:'WWDWL',away_form:'WDLLL',h2h_summary:'TOT 4W last 7',insights:['Spurs home bounce','Forest travel badly','Top 4 battle'],match_time:'16:15',writeup:"Tottenham start 2 goals up at home. Forest lost 3 of last 5 away. Need to avoid a 2-goal defeat — very unlikely."},
    {match_id:`t_ata_ver`,date:d0,league:'Serie A',league_flag:'🇮🇹',home_team:'Atalanta BC',away_team:'Hellas Verona',favorite:'Atalanta BC',handicap:'H1',handicap_label:'Atalanta H1',win_condition:'Starts +1 up, wins unless they lose',probability:80,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWWL',away_form:'LLLLL',h2h_summary:'ATA 6W last 8 home',insights:['Atalanta top form','Verona relegated zone','Goals machine'],match_time:'15:00',writeup:"Atalanta start 1 goal up vs bottom-threatened Verona who lost 5 straight away. Won 6 of last 8 at home."},
    {match_id:`t_fio_int`,date:d0,league:'Serie A',league_flag:'🇮🇹',home_team:'ACF Fiorentina',away_team:'Inter Milano',favorite:'Inter Milano',handicap:'H2',handicap_label:'Inter H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:74,is_banker:0,bookmaker:'Bet9ja',odds:2.00,status:'pending',home_form:'WWLWW',away_form:'WWWDW',h2h_summary:'INT 5W last 8',insights:['Inter title chasing','Fiorentina strong home','Away side quality'],match_time:'20:45',writeup:"Inter start 2 goals up away at Fiorentina. Title-chasing Inter won 5 of last 8 away. Just need to avoid a heavy loss."},
    {match_id:`t_ren_fcm`,date:d0,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Stade Rennais FC',away_team:'FC Metz',favorite:'Stade Rennais FC',handicap:'H1',handicap_label:'Rennes H1',win_condition:'Starts +1 up, wins unless they lose',probability:82,is_banker:1,bookmaker:'1xBet',odds:1.50,status:'pending',home_form:'WWWDW',away_form:'LLLLD',h2h_summary:'REN 6W last 8 home',insights:['🔥 Rennes dominant','Metz bottom 3','Home goal machine'],match_time:'16:15',writeup:"Rennes start 1 goal up vs bottom-3 Metz. Won 6 of last 8 at home. Metz lost 4 straight away. Cannot lose."},
    {match_id:`t_olm_lil`,date:d0,league:'Ligue 1',league_flag:'🇫🇷',home_team:'Olympique Marseille',away_team:'Lille OSC',favorite:'Olympique Marseille',handicap:'H2',handicap_label:'Marseille H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:73,is_banker:0,bookmaker:'Bet9ja',odds:1.95,status:'pending',home_form:'WWWLL',away_form:'WDLWL',h2h_summary:'OLM 4W last 7 home',insights:['Marseille Velodrome','Lille good form','Tight contest'],match_time:'16:15',writeup:"Marseille start 2 goals up at the Vélodrome. Only lose if beaten by 2+ — very unlikely at home."},
    {match_id:`t_crc_ala`,date:d0,league:'La Liga',league_flag:'🇪🇸',home_team:'RC Celta de Vigo',away_team:'Deportivo Alaves',favorite:'RC Celta de Vigo',handicap:'H1',handicap_label:'Celta H1',win_condition:'Starts +1 up, wins unless they lose',probability:75,is_banker:0,bookmaker:'Bet9ja',odds:1.80,status:'pending',home_form:'WWWDL',away_form:'LLDLL',h2h_summary:'CRC 4W last 6 home',insights:['Celta strong home','Alaves poor away','Home advantage'],match_time:'16:15',writeup:"Celta start 1 goal up at home vs struggling Alaves. Won 4 of last 6 at home. Alaves have lost away consistently."},
    // ── TOMORROW ─────────────────────────────────────────────
    {match_id:`tm_mci_ips`,date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Manchester City',away_team:'Ipswich Town',favorite:'Manchester City',handicap:'H1',handicap_label:'Man City H1',win_condition:'Starts +1 up, wins unless they lose',probability:85,is_banker:1,bookmaker:'Bet9ja',odds:1.45,status:'pending',home_form:'WWWWL',away_form:'LLLLL',h2h_summary:'MCI 7W last 8 home',insights:['🔥 City dominant','Ipswich bottom','Etihad fortress'],match_time:'20:00',writeup:"Man City start 1 goal up at home vs bottom Ipswich. Won 7 of last 8 at home. Ipswich lost away all season. City cannot lose."},
    {match_id:`tm_lei_wol`,date:d1,league:'Premier League',league_flag:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',home_team:'Leicester City',away_team:'Wolverhampton',favorite:'Leicester City',handicap:'H2',handicap_label:'Leicester H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:74,is_banker:0,bookmaker:'1xBet',odds:1.95,status:'pending',home_form:'WWDWL',away_form:'LLDLL',h2h_summary:'LEI 4W last 7 home',insights:['Leicester home form','Wolves poor away','King Power advantage'],match_time:'20:00',writeup:"Leicester start 2 goals up at home vs poor away Wolves. 2-goal cushion at home is very comfortable."},
    {match_id:`tm_scf_fca`,date:d1,league:'Bundesliga',league_flag:'🇩🇪',home_team:'SC Freiburg',away_team:'FC Augsburg',favorite:'SC Freiburg',handicap:'H2',handicap_label:'Freiburg H2',win_condition:'Starts +2 up, wins unless lose by 2+',probability:76,is_banker:0,bookmaker:'Betway',odds:2.00,status:'pending',home_form:'WWWLD',away_form:'LLDLL',h2h_summary:'SCF 5W last 7 home',insights:['Freiburg home strong','Augsburg poor away','Europa push'],match_time:'20:30',writeup:"Freiburg start 2 goals up at home vs poor away Augsburg. Won 5 of last 7 at home. Very comfortable position."},
  ];

  for (const s of seeds) {
    await dbUpsert({...s, id:`seed_${s.match_id}`, created_at:new Date().toISOString()});
  }
  console.log(`[Reseed] ✅ ${seeds.length} predictions. Yesterday=${dm1} Today=${d0} Tomorrow=${d1}`);
  res.json({success:true, message:`Reseeded ${seeds.length} predictions!`, yesterday:dm1, today:d0, tomorrow:d1});
});

// Debug — see what football-data.org returns for ALL leagues
app.get('/api/debug-results', async (req, res) => {
  if (!FOOTBALL_KEY) return res.json({error:'No FOOTBALL_KEY'});
  try {
    const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];
    const allMatches = [];
    for (const lg of LEAGUES) {
      const r = await fetch(`https://api.football-data.org/v4/competitions/${lg.code}/matches?dateFrom=${yesterday}&dateTo=${today}&status=FINISHED`, {
        headers: {'X-Auth-Token': FOOTBALL_KEY}
      });
      const d = await r.json();
      (d.matches||[]).forEach(m => allMatches.push({
        league: lg.name,
        home: m.homeTeam?.shortName || m.homeTeam?.name,
        away: m.awayTeam?.shortName || m.awayTeam?.name,
        score: `${m.score?.fullTime?.home}-${m.score?.fullTime?.away}`,
        date: m.utcDate?.split('T')[0]
      }));
      await new Promise(r=>setTimeout(r,500));
    }
    res.json({date_from:yesterday, date_to:today, count:allMatches.length, matches:allMatches});
  } catch(e) { res.json({error: e.message}); }
});

app.get('/api/leagues', (req,res) => res.json(LEAGUES));
app.get('/health', (req,res) => res.json({status:'ok', time:new Date().toISOString()}));

app.listen(PORT, async () => {
  console.log(`🚀 HandicapAI on port ${PORT}`);
  await connectDB();
  const all = await dbLoad();
  if (!all.length) {
    console.log('[Startup] Empty DB — auto-reseeding in 2s...');
    setTimeout(async () => {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/reseed`);
        const d = await r.json();
        console.log('[Startup]', d.message);
      } catch(e) { console.log('[Startup] reseed error:', e.message); }
    }, 2000);
  } else {
    console.log(`[Startup] DB has ${all.length} predictions ✅`);
  }
});

async function connectDB() {
  return await getCol();
}
// Debug endpoint - show all predictions dates
