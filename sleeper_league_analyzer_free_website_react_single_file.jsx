import React, { useEffect, useMemo, useState } from "react";

/**
 * Sleeper League Analyzer — Single‑file React app (free to host anywhere)
 * -----------------------------------------------------------------------
 * What this does
 * - Pulls public data from up to 4 Sleeper fantasy football leagues
 * - Shows "AI-style" draft analysis with letter grades (rule-based heuristics)
 * - Weekly matchup previews (predicted winners + Game of the Week)
 * - Weekly summaries (once games are complete, using Sleeper's matchup points)
 *
 * How to use
 * 1) Replace the LEAGUE_IDS below with your four Sleeper league IDs (as strings).
 *    You can use 1–4 IDs. Find the ID in the URL: https://sleeper.app/leagues/<ID>
 * 2) (Optional) Tweak SCORING_WEIGHTS and POSITION_VALUES to bias the analysis.
 * 3) Deploy this single file for free on GitHub Pages / Netlify / Vercel.
 *
 * Notes
 * - This runs fully client-side using the public Sleeper API with CORS enabled.
 * - "AI generated" analysis here is a transparent, deterministic heuristic so the
 *   site stays 100% free and serverless. It looks/reads like AI, without costs.
 */

/*********************  USER CONFIG  *********************/
const LEAGUE_IDS: string[] = [
  // "123456789012345678", // League 1
  // "234567890123456789", // League 2
  // "345678901234567890", // League 3
  // "456789012345678901", // League 4
];

// Position value multipliers used in draft grades and matchup strength
const POSITION_VALUES: Record<string, number> = {
  QB: 1.15, // single QB leagues: keep <=1.0–1.2; for Superflex, set ~1.4–1.6
  RB: 1.2,
  WR: 1.15,
  TE: 1.05,
  K: 0.6,
  DEF: 0.7,
};

// Round value curve: early rounds are exponentially more valuable
const ROUND_VALUE = (overallPick: number) => 100 / Math.sqrt(overallPick + 2);

// Roster depth targets by position for balanced grade (adjust if your league differs)
const IDEAL_DEPTH: Record<string, number> = { QB: 2, RB: 5, WR: 5, TE: 2, K: 1, DEF: 1 };

// Score weights for draft grading blend
const SCORING_WEIGHTS = {
  topHeavy: 0.45, // value of studs
  balance: 0.25, // positional balance
  depth: 0.20, // bench depth
  volatility: 0.10, // boom/bust tolerance (late-round darts)
};

/*********************  UTILITIES  *********************/
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url}`);
  return res.json();
}

function letterGrade(score: number): { grade: string; note: string } {
  // Score roughly 0–100
  if (score >= 92) return { grade: "A", note: "Elite haul. Cohesive, high-ceiling roster." };
  if (score >= 88) return { grade: "A-", note: "Strong foundation with upside at key spots." };
  if (score >= 84) return { grade: "B+", note: "Rock-solid draft with minor gaps." };
  if (score >= 80) return { grade: "B", note: "Balanced build; competitive immediately." };
  if (score >= 76) return { grade: "B-", note: "Sensible draft; needs a breakout or two." };
  if (score >= 72) return { grade: "C+", note: "Middle of the pack; trade room exists." };
  if (score >= 68) return { grade: "C", note: "Some reaches; lineup decisions will matter." };
  if (score >= 64) return { grade: "C-", note: "Upside plays but fragile floor." };
  if (score >= 58) return { grade: "D+", note: "Risk-forward draft; waivers will be key." };
  if (score >= 52) return { grade: "D", note: "Value left on the board." };
  return { grade: "D-", note: "Rebuild mode: trade early, trade often." };
}

function by<T>(k: (x: T) => number, dir: "asc" | "desc" = "desc") {
  return (a: T, b: T) => (dir === "asc" ? k(a) - k(b) : k(b) - k(a));
}

/*********************  SLEEPER TYPES (partial)  *********************/
// These are light/partial types to make coding easier.

type SleeperLeague = {
  league_id: string;
  name: string;
  season: string;
  total_rosters: number;
  settings: Record<string, any>;
  roster_positions: string[];
};

type SleeperUser = { user_id: string; display_name: string };

type SleeperRoster = {
  roster_id: number;
  owner_id?: string; // maps to user_id
  players?: string[]; // player_ids on roster
  starters?: string[]; // current week starters
};

type SleeperDraft = { draft_id: string; status: string; season: string };

type SleeperPick = {
  player_id: string;
  round: number; // draft round index (1-based)
  pick_no: number; // overall pick number
  roster_id: number; // team that picked
  metadata?: Record<string, any> & { position?: string; team?: string; first_name?: string; last_name?: string };
};

type SleeperMatchup = {
  matchup_id: number;
  roster_id: number;
  starters: string[];
  points?: number; // totals after games
  players_points?: Record<string, number>;
};

/*********************  HEURISTIC ANALYSIS  *********************/
function evaluateDraft(picks: SleeperPick[], league: SleeperLeague, rosters: SleeperRoster[], users: SleeperUser[]) {
  // Build per-team pick lists
  const byTeam: Record<number, SleeperPick[]> = {};
  for (const p of picks) {
    if (!byTeam[p.roster_id]) byTeam[p.roster_id] = [];
    byTeam[p.roster_id].push(p);
  }
  for (const team of Object.values(byTeam)) team.sort(by((x) => x.pick_no, "asc"));

  // Compute scores
  type TeamDraftScore = {
    roster_id: number;
    owner: string;
    topHeavyScore: number;
    balanceScore: number;
    depthScore: number;
    volatilityScore: number;
    total: number;
    notes: string[];
  };

  const rosterOwnerName = (rid: number) => {
    const roster = rosters.find((r) => r.roster_id === rid);
    const owner = users.find((u) => u.user_id === roster?.owner_id);
    return owner?.display_name || `Team ${rid}`;
  };

  const teamScores: TeamDraftScore[] = Object.entries(byTeam).map(([rid, teamPicks]) => {
    const roster_id = Number(rid);

    // 1) Top-heavy: reward early picks, discounted by position scarcity
    const studs = teamPicks.filter((p) => p.pick_no <= 36);
    const studValue = studs.reduce((sum, p) => {
      const pos = (p.metadata?.position || "").toUpperCase();
      return sum + ROUND_VALUE(p.pick_no) * (POSITION_VALUES[pos] || 1);
    }, 0);

    // 2) Balance: how close is positional depth to ideal
    const posCounts: Record<string, number> = {};
    for (const p of teamPicks) {
      const pos = (p.metadata?.position || "").toUpperCase();
      if (!pos) continue;
      posCounts[pos] = (posCounts[pos] || 0) + 1;
    }
    const balancePenalty = Object.entries(IDEAL_DEPTH).reduce((pen, [pos, ideal]) => {
      const have = posCounts[pos] || 0;
      const diff = Math.abs(have - ideal);
      return pen + Math.min(diff, 3) * (1 / (POSITION_VALUES[pos] || 1));
    }, 0);
    const balanceScore = Math.max(0, 10 - balancePenalty) * 8; // 0–80 scaled to ~0–80

    // 3) Depth: total weighted value of rounds 7–14 (bench contributors)
    const depthPicks = teamPicks.filter((p) => p.pick_no > 72 && p.pick_no <= 168);
    const depthScoreRaw = depthPicks.reduce((sum, p) => {
      const pos = (p.metadata?.position || "").toUpperCase();
      return sum + (POSITION_VALUES[pos] || 1) * (60 / Math.sqrt(p.pick_no - 60 + 5));
    }, 0);

    // 4) Volatility: reward some late darts, but penalize chaos
    const latePicks = teamPicks.filter((p) => p.pick_no > 168);
    const lateCount = latePicks.length;
    const volatilityScore = Math.max(0, 10 - Math.max(0, lateCount - 5)) * 5 + Math.min(lateCount, 5) * 2;

    const topHeavyScore = studValue * 3; // scale
    const depthScore = depthScoreRaw * 2.5;

    const total =
      SCORING_WEIGHTS.topHeavy * topHeavyScore +
      SCORING_WEIGHTS.balance * balanceScore +
      SCORING_WEIGHTS.depth * depthScore +
      SCORING_WEIGHTS.volatility * volatilityScore;

    const notes: string[] = [];
    if ((posCounts.RB || 0) >= 2 && studs.some((p) => (p.metadata?.position || "").toUpperCase() === "RB"))
      notes.push("Built around a strong RB core.");
    if ((posCounts.WR || 0) >= 3 && studs.some((p) => (p.metadata?.position || "").toUpperCase() === "WR"))
      notes.push("Premium WR room with weekly ceiling.");
    if ((posCounts.QB || 0) >= 2) notes.push("QB depth offers trade leverage.");
    if ((posCounts.TE || 0) >= 2) notes.push("TE insulation for bye/injury weeks.");
    if (lateCount >= 6) notes.push("Late-round upside shots could swing the league.");

    return { roster_id, owner: rosterOwnerName(roster_id), topHeavyScore, balanceScore, depthScore, volatilityScore, total, notes };
  });

  // Normalize totals to 0–100 scale for prettier grades
  const maxTotal = Math.max(1, ...teamScores.map((t) => t.total));
  for (const t of teamScores) t.total = (t.total / maxTotal) * 100;

  const graded = teamScores
    .map((t) => ({ ...t, ...letterGrade(t.total) }))
    .sort(by((x) => x.total));

  return graded;
}

function strengthFromDraft(teams: ReturnType<typeof evaluateDraft>) {
  // Convert draft grades into a continuous team power index for matchup previews
  return Object.fromEntries(
    teams.map((t) => [t.roster_id, 50 + (t.total - 75) * 1.25]) // center ~50, spread by grade
  );
}

function previewMatchups(
  week: number,
  matchups: SleeperMatchup[],
  powerIndex: Record<number, number>
) {
  // Pair matchups by matchup_id
  const byId: Record<number, SleeperMatchup[]> = {};
  for (const m of matchups) {
    if (!byId[m.matchup_id]) byId[m.matchup_id] = [];
    byId[m.matchup_id].push(m);
  }
  type Preview = { matchup_id: number; a: number; b: number; aPower: number; bPower: number; diff: number };
  const previews: Preview[] = Object.entries(byId).map(([mid, two]) => {
    const [m1, m2] = two;
    const a = m1?.roster_id ?? two[0]?.roster_id;
    const b = m2?.roster_id ?? two[1]?.roster_id;
    const aPower = powerIndex[a] ?? 50;
    const bPower = powerIndex[b] ?? 50;
    return { matchup_id: Number(mid), a, b, aPower, bPower, diff: Math.abs(aPower - bPower) };
  });
  previews.sort(by((p) => p.diff, "asc"));
  const gameOfWeek = previews[0];
  return { previews, gameOfWeek };
}

function summarizeCompletedMatchups(
  matchups: SleeperMatchup[],
  rosters: SleeperRoster[],
  users: SleeperUser[]
) {
  const byId: Record<number, SleeperMatchup[]> = {};
  for (const m of matchups) {
    if (!byId[m.matchup_id]) byId[m.matchup_id] = [];
    byId[m.matchup_id].push(m);
  }
  const nameFor = (rid: number) => {
    const r = rosters.find((x) => x.roster_id === rid);
    const u = users.find((x) => x.user_id === r?.owner_id);
    return u?.display_name || `Team ${rid}`;
  };
  return Object.values(byId).map((pair) => {
    const [m1, m2] = pair;
    const A = m1;
    const B = m2;
    const aName = nameFor(A?.roster_id || 0);
    const bName = nameFor(B?.roster_id || 0);
    const aPts = (A?.points || 0);
    const bPts = (B?.points || 0);
    const winner = aPts === bPts ? "Tie" : aPts > bPts ? aName : bName;
    const margin = Math.abs(aPts - bPts).toFixed(2);

    const star = () => {
      // find highest single-starter points across both
      const entries = [A,B].flatMap((m) => Object.entries(m?.players_points || {}));
      const best = entries.sort((a,b)=>b[1]-a[1])[0];
      if (!best) return null;
      return { player_id: best[0], points: best[1] };
    };

    return {
      matchup_id: A?.matchup_id ?? B?.matchup_id,
      aName,
      bName,
      aPts: aPts.toFixed(2),
      bPts: bPts.toFixed(2),
      winner,
      margin,
      star: star(),
    };
  });
}

/*********************  DATA FETCHING  *********************/
async function loadLeagueBundle(league_id: string) {
  const league = await fetchJSON<SleeperLeague>(`https://api.sleeper.app/v1/league/${league_id}`);
  const [users, rosters] = await Promise.all([
    fetchJSON<SleeperUser[]>(`https://api.sleeper.app/v1/league/${league_id}/users`),
    fetchJSON<SleeperRoster[]>(`https://api.sleeper.app/v1/league/${league_id}/rosters`),
  ]);

  // Draft data (take the most recent draft)
  const drafts = await fetchJSON<SleeperDraft[]>(`https://api.sleeper.app/v1/league/${league_id}/drafts`);
  let draftPicks: SleeperPick[] = [];
  if (drafts && drafts.length) {
    const draft_id = drafts[0].draft_id; // newest first
    draftPicks = await fetchJSON<SleeperPick[]>(`https://api.sleeper.app/v1/draft/${draft_id}/picks`);
  }

  return { league, users, rosters, draftPicks };
}

async function loadWeekMatchups(league_id: string, week: number) {
  return fetchJSON<SleeperMatchup[]>(`https://api.sleeper.app/v1/league/${league_id}/matchups/${week}`);
}

async function getCurrentNFLState() {
  return fetchJSON<{ season: string; season_type: string; week: number }>(`https://api.sleeper.app/v1/state/nfl`);
}

/*********************  UI  *********************/
function Pill({ children }: { children: React.ReactNode }) {
  return <span className="px-2 py-1 rounded-full text-xs bg-gray-100 border">{children}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="my-6">
      <div className="text-xl font-semibold mb-3">{title}</div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="p-4 rounded-2xl border shadow-sm bg-white">{children}</div>;
}

function Loader() {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-600">
      <div className="animate-spin w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full" />
      Loading…
    </div>
  );
}

function LeagueHeader({ league }: { league: SleeperLeague }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div>
        <div className="text-2xl font-bold">{league.name}</div>
        <div className="text-sm text-gray-600">Season {league.season} • {league.total_rosters} teams</div>
      </div>
    </div>
  );
}

function DraftGrades({ data }: { data: ReturnType<typeof evaluateDraft> }) {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
      {data.map((t) => (
        <Card key={t.roster_id}>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-lg font-semibold">{t.owner}</div>
              <div className="text-sm text-gray-600">Draft Grade</div>
            </div>
            <div className="text-3xl font-black">{t.grade}</div>
          </div>
          <div className="mt-3 text-sm">
            <div className="font-medium">{t.note}</div>
            <div className="mt-1 text-gray-700">Heuristic score: {t.total.toFixed(1)}</div>
            {t.notes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {t.notes.map((n, i) => (
                  <Pill key={i}>{n}</Pill>
                ))}
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function Previews({ week, previews, rosterMap, users }: { week: number; previews: ReturnType<typeof previewMatchups>["previews"]; rosterMap: Record<number, SleeperRoster>; users: SleeperUser[] }) {
  const nameFor = (rid: number) => {
    const r = rosterMap[rid];
    const u = users.find((x) => x.user_id === r?.owner_id);
    return u?.display_name || `Team ${rid}`;
  };
  return (
    <div className="grid md:grid-cols-2 gap-3">
      {previews.map((p) => (
        <Card key={p.matchup_id}>
          <div className="flex items-center justify-between">
            <div className="font-semibold">Week {week} Preview</div>
            <Pill>Diff {p.diff.toFixed(1)}</Pill>
          </div>
          <div className="mt-2 text-lg">
            {nameFor(p.a)} (<span className="font-mono">{p.aPower.toFixed(1)}</span>)
            <span className="mx-2">vs</span>
            {nameFor(p.b)} (<span className="font-mono">{p.bPower.toFixed(1)}</span>)
          </div>
          <div className="mt-2 text-sm text-gray-700">
            {p.aPower === p.bPower ? "Toss-up" : p.aPower > p.bPower ? `${nameFor(p.a)} slight favorite` : `${nameFor(p.b)} slight favorite`}
          </div>
        </Card>
      ))}
    </div>
  );
}

function Summaries({ items }: { items: ReturnType<typeof summarizeCompletedMatchups> }) {
  return (
    <div className="grid md:grid-cols-2 gap-3">
      {items.map((s) => (
        <Card key={s.matchup_id}>
          <div className="flex items-center justify-between">
            <div className="font-semibold">Final</div>
            <Pill>Margin {s.margin}</Pill>
          </div>
          <div className="mt-2 text-lg">
            {s.aName} <span className="font-mono">{s.aPts}</span>
            <span className="mx-2">—</span>
            {s.bName} <span className="font-mono">{s.bPts}</span>
          </div>
          <div className="mt-2 text-sm text-gray-700">
            {s.winner === "Tie" ? "Dead even — a rare draw." : `${s.winner} wins by ${s.margin}.`}
            {s.star && (
              <div className="mt-1">Star of the game: {s.star.player_id} ({s.star.points.toFixed(1)} pts)</div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

export default function App() {
  const [leagueIds, setLeagueIds] = useState<string[]>(LEAGUE_IDS);
  const [bundles, setBundles] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<{ season: string; season_type: string; week: number } | null>(null);
  const [activeLeague, setActiveLeague] = useState<string | null>(null);
  const [week, setWeek] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Allow users to paste league IDs at runtime if not pre-configured
  const [idInput, setIdInput] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const nfl = await getCurrentNFLState();
        setState(nfl);
        setWeek(nfl.week);
        setStatus(`${nfl.season_type} • week ${nfl.week}`);
        if (leagueIds.length) {
          for (const id of leagueIds) {
            await loadOne(id);
            await sleep(200); // be gentle
          }
          setActiveLeague(leagueIds[0]);
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadOne(id: string) {
    setBundles((b: any) => ({ ...b, [id]: { loading: true } }));
    try {
      const bundle = await loadLeagueBundle(id);
      const draft = evaluateDraft(bundle.draftPicks, bundle.league, bundle.rosters, bundle.users);
      const power = strengthFromDraft(draft);
      setBundles((b: any) => ({ ...b, [id]: { ...bundle, draft, power, loading: false } }));
    } catch (e) {
      console.error(e);
      setBundles((b: any) => ({ ...b, [id]: { error: String(e), loading: false } }));
    }
  }

  const active = activeLeague ? bundles[activeLeague] : null;

  const rosterMap: Record<number, SleeperRoster> = useMemo(() => {
    const m: Record<number, SleeperRoster> = {};
    if (active?.rosters) for (const r of active.rosters) m[r.roster_id] = r;
    return m;
  }, [active]);

  const [matchups, setMatchups] = useState<SleeperMatchup[] | null>(null);
  const [matchupsWeek, setMatchupsWeek] = useState<number | null>(null);
  const [loadingWeek, setLoadingWeek] = useState(false);

  async function loadWeek(w: number) {
    if (!activeLeague) return;
    setLoadingWeek(true);
    try {
      const m = await loadWeekMatchups(activeLeague, w);
      setMatchups(m);
      setMatchupsWeek(w);
    } finally {
      setLoadingWeek(false);
    }
  }

  useEffect(() => {
    if (activeLeague && week != null) loadWeek(week);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLeague]);

  function addLeagueId() {
    const parts = idInput
      .split(/\s|,|;|\n|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = Array.from(new Set([...leagueIds, ...parts])).slice(0, 4);
    setLeagueIds(next);
    setIdInput("");
    const newlyAdded = next.filter((x) => !bundles[x]);
    (async () => {
      for (const id of newlyAdded) {
        await loadOne(id);
        await sleep(150);
      }
      if (!activeLeague && next.length) setActiveLeague(next[0]);
    })();
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-3xl font-extrabold">Sleeper League Analyzer</div>
            <div className="text-sm text-gray-600">Free, serverless site — plug in up to 4 league IDs • {status || (loading ? "loading NFL state…" : "ready")}</div>
          </div>
          <div className="flex gap-2">
            <input value={idInput} onChange={(e)=>setIdInput(e.target.value)} placeholder="Paste Sleeper League IDs (up to 4)" className="px-3 py-2 rounded-xl border bg-white w-72" />
            <button onClick={addLeagueId} className="px-3 py-2 rounded-xl border bg-white hover:bg-gray-100">Add</button>
          </div>
        </div>

        {/* League Tabs */}
        <div className="mt-4 flex flex-wrap gap-2">
          {leagueIds.length === 0 && <Pill>No leagues added yet — paste IDs above</Pill>}
          {leagueIds.map((id) => (
            <button key={id} onClick={()=>setActiveLeague(id)} className={`px-3 py-1 rounded-full border ${activeLeague===id?"bg-black text-white":"bg-white hover:bg-gray-100"}`}>
              {bundles[id]?.league?.name ? `${bundles[id].league.name}` : `League ${id.slice(-6)}`}
            </button>
          ))}
        </div>

        {/* Active League View */}
        {activeLeague && (
          <div className="mt-6">
            {active?.loading && <Loader />}
            {active?.error && <div className="text-red-600">{String(active.error)}</div>}
            {active?.league && (
              <>
                <LeagueHeader league={active.league} />

                {/* Draft Grades */}
                <Section title="Draft Grades (Heuristic AI)">
                  {active.draft ? <DraftGrades data={active.draft} /> : <Loader />}
                </Section>

                {/* Week Controls */}
                <Section title="Weekly Matchups">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="text-sm">Select week:</div>
                    <select value={matchupsWeek ?? week ?? 1} onChange={(e)=>loadWeek(parseInt(e.target.value))} className="px-3 py-2 rounded-xl border bg-white">
                      {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
                        <option key={w} value={w}>Week {w}</option>
                      ))}
                    </select>
                    {loadingWeek && <Loader />}
                  </div>

                  {matchups && matchups.length > 0 ? (
                    (() => {
                      const power = active.power as Record<number, number>;
                      const { previews, gameOfWeek } = previewMatchups(matchupsWeek ?? week ?? 1, matchups, power);
                      return (
                        <>
                          {gameOfWeek && (
                            <Card>
                              <div className="text-sm font-semibold mb-1">Game of the Week (closest matchup)</div>
                              <div className="text-lg">Matchup #{gameOfWeek.matchup_id} • Diff {gameOfWeek.diff.toFixed(1)}</div>
                              <div className="text-sm text-gray-700">Predictions based on draft-derived power index.</div>
                            </Card>
                          )}
                          <Previews week={matchupsWeek ?? week ?? 1} previews={previews} rosterMap={rosterMap} users={active.users} />
                        </>
                      );
                    })()
                  ) : (
                    <Card>
                      <div className="text-sm">No Sleeper matchup data for this week (league may be in playoffs/offseason).</div>
                    </Card>
                  )}
                </Section>

                {/* Summaries for completed weeks */}
                {state && matchupsWeek != null && matchupsWeek < state.week && (
                  <Section title={`Week ${matchupsWeek} Summaries`}>
                    {matchups ? <Summaries items={summarizeCompletedMatchups(matchups, active.rosters, active.users)} /> : <Loader />}
                  </Section>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-10 text-xs text-gray-500">
          Tip: For Superflex leagues, increase POSITION_VALUES.QB to ~1.5 for better previews.
        </div>
      </div>
    </div>
  );
}
