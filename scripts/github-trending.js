#!/usr/bin/env node

const API_BASE = 'https://cloudflare-mcp1.zx1993.top/api/trending';
const LANGUAGES = ['', 'python', 'javascript', 'typescript', 'go'];
const PERIODS = ['weekly', 'monthly'];

async function fetchJson(url, timeout = 15000) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'github-blindbox/1.0' },
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.json();
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeItems(items, source, period) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item && item.username && item.reponame)
    .map(item => {
      const starsToday = numeric(item.starsToday);
      return {
        rank: 0,
        owner: item.username,
        name: item.reponame,
        fullName: `${item.username}/${item.reponame}`,
        url: item.url || `https://github.com/${item.username}/${item.reponame}`,
        description: String(item.description || '').trim() || '（暂无描述）',
        language: item.language || 'Unknown',
        stars: numeric(item.stars),
        forks: numeric(item.forks),
        // The upstream API keeps this field name for every period. Its unit is
        // determined by primaryPeriod, never by the field name itself.
        starsToday,
        periodData: {
          [period]: {
            stars: numeric(item.stars),
            forks: numeric(item.forks),
            starsToday
          }
        },
        periods: [period],
        primaryPeriod: period,
        source,
        sources: [source]
      };
    });
}

function periodPriority(period) {
  return PERIODS.indexOf(period) === -1 ? PERIODS.length : PERIODS.indexOf(period);
}

function resolvePrimaryPeriod(periods) {
  return [...periods].sort((a, b) => periodPriority(a) - periodPriority(b))[0] || 'monthly';
}

function mergeRepo(existing, incoming) {
  const periods = new Set([...(existing.periods || []), ...(incoming.periods || [])]);
  const periodData = { ...(existing.periodData || {}), ...(incoming.periodData || {}) };
  const sources = [...new Set([...(existing.sources || [existing.source]), ...(incoming.sources || [incoming.source])].filter(Boolean))];
  const primaryPeriod = resolvePrimaryPeriod(periods);
  const primaryData = periodData[primaryPeriod] || incoming.periodData?.[incoming.primaryPeriod] || {};
  const snapshots = Object.values(periodData);

  return {
    ...existing,
    description: existing.description === '（暂无描述）' ? incoming.description : existing.description,
    language: existing.language === 'Unknown' ? incoming.language : existing.language,
    periods: [...periods].sort((a, b) => periodPriority(a) - periodPriority(b)),
    primaryPeriod,
    periodData,
    // Total stars/forks should not change with the Trending period. The API
    // can return snapshots from slightly different times, so keep the newest
    // looking (largest) total while using the preferred period for growth.
    stars: Math.max(numeric(existing.stars), numeric(incoming.stars), ...snapshots.map(item => numeric(item.stars))),
    forks: Math.max(numeric(existing.forks), numeric(incoming.forks), ...snapshots.map(item => numeric(item.forks))),
    starsToday: numeric(primaryData.starsToday),
    source: sources.join(','),
    sources
  };
}

async function main() {
  const seen = new Map();

  const requests = PERIODS.flatMap(period => LANGUAGES.map(language => ({ period, language })));
  const results = await Promise.allSettled(
    requests.map(async ({ period, language }) => {
      const url = new URL(API_BASE);
      url.searchParams.set('since', period);
      if (language) url.searchParams.set('language', language);

      const body = await fetchJson(url);
      return {
        period,
        language: language || 'all',
        repos: normalizeItems(body.data, `api-${period}-${language || 'all'}`, period)
      };
    })
  );

  const periodCounts = Object.fromEntries(PERIODS.map(period => [period, 0]));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      periodCounts[result.value.period] += result.value.repos.length;
      for (const repo of result.value.repos) {
        const current = seen.get(repo.fullName);
        seen.set(repo.fullName, current ? mergeRepo(current, repo) : repo);
      }
    } else {
      console.error(`[trending] ${result.reason?.message || result.reason}`);
    }
  }

  const repos = [...seen.values()]
    .sort((a, b) => b.starsToday - a.starsToday || b.stars - a.stars || a.fullName.localeCompare(b.fullName))
    .map((repo, index) => ({
      ...repo,
      rank: index + 1
    }));

  if (repos.length === 0) {
    throw new Error('weekly/monthly Trending 数据请求均失败或没有返回有效项目');
  }

  console.error(`[trending] Got ${repos.length} unique repos from weekly=${periodCounts.weekly}, monthly=${periodCounts.monthly} across ${LANGUAGES.length} language dimensions`);

  console.log(JSON.stringify({
    repos,
    periods: PERIODS,
    languages: LANGUAGES,
    fetchedAt: new Date().toISOString(),
    count: repos.length
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({
    status: 'error',
    message: error.message
  }));

  process.exit(1);
});
