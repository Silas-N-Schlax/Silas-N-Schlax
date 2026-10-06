// Builds the 1x4 stats row (stats, rank, streak, total contributions) as dark and light SVGs.
import { mkdirSync, writeFileSync } from "node:fs";
import octicons from "@primer/octicons";

const USERNAME = process.env.PROFILE_USER;
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = "profile-stats";

const THEMES = {
  dark: { bg: "#0d1117", border: "#30363d", text: "#c9d1d9", muted: "#8b949e", accent: "#58a6ff", track: "#21262d" },
  light: { bg: "#ffffff", border: "#e5e7eb", text: "#1f2937", muted: "#6b7280", accent: "#2563eb", track: "#e5e7eb" },
};

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function totalCommits() {
  const res = await fetch(`https://api.github.com/search/commits?q=author:${USERNAME}`, {
    headers: { Authorization: `bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
  });
  return (await res.json()).total_count ?? 0;
}

async function fetchStats() {
  const { user } = await graphql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        pullRequests { totalCount }
        openIssues: issues(states: OPEN) { totalCount }
        closedIssues: issues(states: CLOSED) { totalCount }
        repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
        contributionsCollection { totalPullRequestReviewContributions }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false) { nodes { stargazerCount } }
      }
    }`,
    { login: USERNAME },
  );

  return {
    createdAt: new Date(user.createdAt),
    commits: await totalCommits(),
    prs: user.pullRequests.totalCount,
    issues: user.openIssues.totalCount + user.closedIssues.totalCount,
    reviews: user.contributionsCollection.totalPullRequestReviewContributions,
    contributedTo: user.repositoriesContributedTo.totalCount,
    followers: user.followers.totalCount,
    stars: user.repositories.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0),
  };
}

async function fetchContributionDays(createdAt) {
  const days = [];
  const now = new Date();
  for (let year = createdAt.getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const from = new Date(Math.max(Date.UTC(year, 0, 1), createdAt.getTime()));
    const to = new Date(Math.min(Date.UTC(year, 11, 31, 23, 59, 59), now.getTime()));
    const { user } = await graphql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar { weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      { login: USERNAME, from: from.toISOString(), to: to.toISOString() },
    );
    for (const week of user.contributionsCollection.contributionCalendar.weeks) {
      days.push(...week.contributionDays);
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function streaks(days) {
  const total = days.reduce((sum, day) => sum + day.contributionCount, 0);

  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null, end: null };
  for (const day of days) {
    if (day.contributionCount > 0) {
      run = { length: run.length + 1, start: run.start ?? day.date, end: day.date };
      if (run.length > longest.length) longest = { ...run };
    } else {
      run = { length: 0, start: null, end: null };
    }
  }

  // Today not having a contribution yet shouldn't break the current streak.
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  const current = { length: 0, start: null, end: days[i]?.date ?? null };
  for (; i >= 0 && days[i].contributionCount > 0; i--) {
    current.length++;
    current.start = days[i].date;
  }

  return { total, firstDay: days[0]?.date, current, longest };
}

// Same scoring as github-readme-stats, so the rank matches what that card showed.
function rank({ commits, prs, issues, reviews, stars, followers }) {
  const exponentialCdf = (x) => 1 - 2 ** -x;
  const logNormalCdf = (x) => x / (1 + x);
  const weighted = [
    [2, exponentialCdf(commits / 1000)],
    [3, exponentialCdf(prs / 50)],
    [1, exponentialCdf(issues / 25)],
    [1, exponentialCdf(reviews / 2)],
    [4, logNormalCdf(stars / 50)],
    [1, logNormalCdf(followers / 10)],
  ];
  const totalWeight = weighted.reduce((sum, [weight]) => sum + weight, 0);
  const percentile = (1 - weighted.reduce((sum, [weight, score]) => sum + weight * score, 0) / totalWeight) * 100;
  const thresholds = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const levels = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
  return { level: levels[thresholds.findIndex((t) => percentile <= t)], percentile };
}

const formatDate = (iso, withYear = false) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear && { year: "numeric" }),
    timeZone: "UTC",
  });
const range = ({ start, end }) => (start ? `${formatDate(start)} – ${formatDate(end)}` : "No streak yet");
const icon = (name, x, y, color) =>
  `<svg x="${x}" y="${y}" width="16" height="16" viewBox="0 0 16 16" fill="${color}">${octicons[name].heights[16].path}</svg>`;

function render(theme, stats, streak, rankInfo) {
  const t = THEMES[theme];
  const width = 880;
  const height = 190;
  const gap = 12;
  const tileWidths = [260, 180, 200, 0];
  tileWidths[3] = width - 2 - gap * 3 - tileWidths.slice(0, 3).reduce((a, b) => a + b, 0);

  let x = 1;
  const tiles = tileWidths.map((w, index) => {
    const tile = { x, w, index };
    x += w + gap;
    return tile;
  });

  const frame = ({ x, w, index }, body) => `
  <g class="tile" style="animation-delay: ${index * 120}ms">
    <rect x="${x}" y="1" width="${w}" height="${height - 2}" rx="10" fill="${t.bg}" stroke="${t.border}" />
    ${body}
  </g>`;

  const statRows = [
    ["star", "Stars earned", stats.stars],
    ["git-commit", "Total commits", stats.commits.toLocaleString("en-US")],
    ["git-pull-request", "Pull requests", stats.prs],
    ["issue-opened", "Issues", stats.issues],
    ["repo", "Contributed to", stats.contributedTo],
  ];
  const statsTile = frame(
    tiles[0],
    statRows
      .map(([name, label, value], row) => {
        const y = 44 + row * 28;
        return `
    ${icon(name, tiles[0].x + 22, y - 12, t.accent)}
    <text x="${tiles[0].x + 48}" y="${y}" class="label">${label}</text>
    <text x="${tiles[0].x + tiles[0].w - 22}" y="${y}" class="value" text-anchor="end">${value}</text>`;
      })
      .join(""),
  );

  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const rankCx = tiles[1].x + tiles[1].w / 2;
  const filled = circumference * (1 - rankInfo.percentile / 100);
  const rankTile = frame(
    tiles[1],
    `
    <circle cx="${rankCx}" cy="84" r="${radius}" fill="none" stroke="${t.track}" stroke-width="7" />
    <circle class="ring" cx="${rankCx}" cy="84" r="${radius}" fill="none" stroke="${t.accent}" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${rankCx} 84)" />
    <text x="${rankCx}" y="94" class="big" text-anchor="middle">${rankInfo.level}</text>
    <text x="${rankCx}" y="160" class="muted" text-anchor="middle">GitHub rank</text>`,
  );

  const sx = tiles[2].x + 24;
  const streakTile = frame(
    tiles[2],
    `
    ${icon("flame", sx, 22, t.accent)}
    <text x="${sx + 24}" y="35" class="heading">Streak</text>
    <text x="${sx}" y="86" class="big">${streak.current.length}</text>
    <text x="${sx + 12 + String(streak.current.length).length * 22}" y="86" class="label">day${streak.current.length === 1 ? "" : "s"} current</text>
    <text x="${sx}" y="106" class="muted">${range(streak.current)}</text>
    <line x1="${sx}" x2="${tiles[2].x + tiles[2].w - 24}" y1="124" y2="124" stroke="${t.border}" />
    <text x="${sx}" y="150" class="value">${streak.longest.length} days longest</text>
    <text x="${sx}" y="170" class="muted">${range(streak.longest)}</text>`,
  );

  const tx = tiles[3].x + 24;
  const totalTile = frame(
    tiles[3],
    `
    ${icon("calendar", tx, 22, t.accent)}
    <text x="${tx + 24}" y="35" class="heading">Contributions</text>
    <text x="${tx}" y="104" class="big">${streak.total.toLocaleString("en-US")}</text>
    <text x="${tx}" y="130" class="label">total contributions</text>
    <text x="${tx}" y="170" class="muted">${formatDate(streak.firstDay, true)} – Present</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub stats for ${USERNAME}">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .label { font-size: 14px; fill: ${t.text}; }
    .value { font-size: 14px; font-weight: 600; fill: ${t.text}; }
    .muted { font-size: 12px; fill: ${t.muted}; }
    .heading { font-size: 14px; font-weight: 600; fill: ${t.accent}; }
    .big { font-size: 36px; font-weight: 700; fill: ${t.text}; }
    .tile { opacity: 0; animation: fade 600ms ease-out forwards; }
    .ring { stroke-dashoffset: ${filled}; animation: fill 1s ease-out 300ms forwards; }
    @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes fill { to { stroke-dashoffset: 0; } }
    @media (prefers-reduced-motion: reduce) { .tile, .ring { animation: none; opacity: 1; stroke-dashoffset: 0; } }
  </style>${statsTile}${rankTile}${streakTile}${totalTile}
</svg>
`;
}

const stats = await fetchStats();
const streak = streaks(await fetchContributionDays(stats.createdAt));
const rankInfo = rank(stats);

mkdirSync(OUT_DIR, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  writeFileSync(`${OUT_DIR}/stats-${theme}.svg`, render(theme, stats, streak, rankInfo));
}
console.log({ ...stats, rank: rankInfo, streak });
