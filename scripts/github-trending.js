#!/usr/bin/env node

const API_BASE = 'https://cloudflare-mcp1.zx1993.top/api/trending';
const LANGUAGES = ['', 'python', 'javascript', 'typescript', 'go'];

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

function normalizeItems(items, source) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item && item.username && item.reponame)
    .map(item => ({
      rank: 0,
      owner: item.username,
      name: item.reponame,
      fullName: `${item.username}/${item.reponame}`,
      url: item.url || `https://github.com/${item.username}/${item.reponame}`,
      description: String(item.description || '').trim() || '（暂无描述）',
      language: item.language || 'Unknown',
      stars: Number(item.stars) || 0,
      forks: Number(item.forks) || 0,
      starsToday: Number(item.starsToday) || 0,
      source
    }));
}

async function main() {
  const seen = new Map();

  const results = await Promise.allSettled(
    LANGUAGES.map(async language => {
      const url = new URL(API_BASE);
      url.searchParams.set('since', 'daily');

      if (language) {
        url.searchParams.set('language', language);
      }

      const body = await fetchJson(url);
      return normalizeItems(body.data, `api-${language || 'all'}`);
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const repo of result.value) {
        if (!seen.has(repo.fullName)) {
          seen.set(repo.fullName, repo);
        }
      }
    } else {
      console.error(`[trending] ${result.reason?.message || result.reason}`);
    }
  }

  const repos = [...seen.values()]
    .sort((a, b) => b.starsToday - a.starsToday || b.stars - a.stars)
    .map((repo, index) => ({
      ...repo,
      rank: index + 1
    }));

  if (repos.length === 0) {
    throw new Error('所有 Trending 数据请求均失败或没有返回有效项目');
  }

  console.error(`[trending] Got ${repos.length} unique repos`);

  console.log(JSON.stringify({
    repos,
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
