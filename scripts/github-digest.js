#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const FRESH_COOLDOWN_DAYS = 7;
const EVERGREEN_COOLDOWN_DAYS = 14;
const MAX_POOL_GENERATION_ATTEMPTS = 3;
const MAX_LENGTH_REWRITE_ATTEMPTS = 2;
const MIN_DIGEST_BYTES = 3600
const FRESH_SELECTION_LIMIT = 7;
const EVERGREEN_SELECTION_LIMIT = 3;
const MIN_TOTAL_RECOMMENDATIONS = 5;
const MAX_TOTAL_RECOMMENDATIONS = 10;
const MIN_EVERGREEN_POOL = 12;
const FRESH_SHORTLIST_LIMIT = 60;
const EVERGREEN_SHORTLIST_LIMIT = 30;
const DEFAULT_DIVERSITY_POLICY = {
  maxAiProjects: 2,
  maxPerTopic: 1,
  minDistinctTopics: 4,
  ownerCooldownDays: 7,
  semanticCooldownDays: 7,
  allowReducedDigest: true
};

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { excludeList: [], historyOutput: null, historyStateFile: null, historyStateOutput: null, selectionOutput: null, dataAgeHours: null, dryRun: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--exclude-file' && args[index + 1]) {
      try {
        const history = JSON.parse(readFileSync(args[index + 1], 'utf8'));
        parsed.excludeList = Array.isArray(history) ? history.filter(name => typeof name === 'string') : [];
      } catch (error) {
        console.error(`[github-digest] Warning: could not read exclude file: ${error.message}`);
      }
      index++;
    } else if (args[index] === '--history-output' && args[index + 1]) {
      parsed.historyOutput = args[++index];
    } else if (args[index] === '--history-state-file' && args[index + 1]) {
      parsed.historyStateFile = args[++index];
    } else if (args[index] === '--history-state-output' && args[index + 1]) {
      parsed.historyStateOutput = args[++index];
    } else if (args[index] === '--selection-output' && args[index + 1]) {
      parsed.selectionOutput = args[++index];
    } else if (args[index] === '--dry-run') {
      parsed.dryRun = true;
    } else if (args[index] === '--data-age-hours' && args[index + 1]) {
      const value = Number(args[++index]);
      if (Number.isFinite(value) && value >= 0) parsed.dataAgeHours = Math.floor(value);
    }
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function loadPreferences() {
  const configPath = join(PROJECT_ROOT, 'config', 'preferences.json');
  try {
    const preferences = JSON.parse(readFileSync(configPath, 'utf8'));
    console.error(`[github-digest] Preferences loaded from ${configPath}`);
    return preferences;
  } catch (error) {
    console.error(`[github-digest] Warning: could not load preferences: ${error.message}`);
    return { readerProfile: '企业 AI 落地、零售运营提效、知识库和自动化流程建设者，偏好能迁移到真实业务的项目。', hardFilters: [] };
  }
}

function hardFilterRepos(repos, preferences) {
  const dropped = [];
  const kept = repos.filter(repo => {
    for (const rule of preferences.hardFilters || []) {
      const field = rule.field === 'fullName' ? repo.fullName || '' : repo.description || '';
      let pattern;
      try { pattern = new RegExp(rule.pattern, 'i'); } catch { continue; }
      if (pattern.test(field) && !(rule.starsException && repo.stars >= rule.starsException)) {
        dropped.push({ repo, reason: rule.reason });
        return false;
      }
    }
    return true;
  });
  return { kept, dropped };
}

function loadHistoryState(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const state = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(state.entries)) throw new Error('entries must be an array');
    return state;
  } catch (error) {
    console.error(`[github-digest] Warning: could not read history state: ${error.message}`);
    return null;
  }
}

function namesInCooldown(entries, days, now) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return new Set(entries
    .filter(entry => typeof entry.fullName === 'string' && Number.isFinite(Date.parse(entry.sentAt)) && Date.parse(entry.sentAt) >= cutoff)
    .map(entry => entry.fullName));
}

function normalizePeriods(repo) {
  if (Array.isArray(repo.periods) && repo.periods.length > 0) return repo.periods;
  const source = String(repo.source || '');
  const periods = ['daily', 'weekly', 'monthly'].filter(period => source.includes(period));
  return periods.length > 0 ? periods : ['weekly'];
}

// 热度单位映射：starsToday 的增量周期跟 primaryPeriod 对齐
const GROWTH_UNIT = { daily: '星/日', weekly: '星/周', monthly: '星/月' };

function resolvePrimaryPeriod(repo) {
  if (repo.primaryPeriod) return repo.primaryPeriod;
  // 旧数据兜底：从 periods 取最短周期
  if (Array.isArray(repo.periods)) {
    if (repo.periods.includes('daily')) return 'daily';
    if (repo.periods.includes('weekly')) return 'weekly';
    if (repo.periods.includes('monthly')) return 'monthly';
  }
  return 'weekly';
}

function normalizeDiversityPolicy(preferences) {
  const source = preferences.diversityPolicy || {};
  const number = (key, minimum) => Number.isInteger(source[key]) && source[key] >= minimum
    ? source[key]
    : DEFAULT_DIVERSITY_POLICY[key];
  return {
    maxAiProjects: number('maxAiProjects', 0),
    maxPerTopic: number('maxPerTopic', 1),
    minDistinctTopics: number('minDistinctTopics', 1),
    ownerCooldownDays: number('ownerCooldownDays', 0),
    semanticCooldownDays: number('semanticCooldownDays', 0),
    allowReducedDigest: typeof source.allowReducedDigest === 'boolean'
      ? source.allowReducedDigest
      : DEFAULT_DIVERSITY_POLICY.allowReducedDigest
  };
}

const TOPIC_DEFINITIONS = [
  { key: 'knowledge-rag', label: '企业知识库 / RAG', ai: true, ecosystem: 'knowledge', pattern: /\brag\b|retrieval.?augmented|knowledge base|knowledge management|document (qa|question answering)|semantic search|vector (search|database|store)|embedding|document intelligence/ },
  { key: 'business-automation', label: '业务自动化 / 工作流', ai: true, ecosystem: 'automation', pattern: /workflow|automation|n8n|zapier|make\.com|power automate|crm|erp|helpdesk|ticketing|approval|email automation|task management/ },
  { key: 'retail-operations', label: '零售 / 经营场景', ai: false, ecosystem: 'retail', pattern: /retail|point of sale|\bpos\b|inventory|merchandis|store management|supply chain|warehouse|e-commerce|customer service|sales enablement/ },
  { key: 'business-data', label: '经营数据 / 分析', ai: false, ecosystem: 'data', pattern: /analytics|dashboard|business intelligence|\bbi\b|data visualization|reporting|forecast|etl|csv|excel|spreadsheet|sql|financial|business data/ },
  { key: 'ai-integration', label: 'MCP / AI 集成', ai: true, ecosystem: 'ai-integration', pattern: /\bmcp\b|model context protocol|cursor.*figma|claude.*plugin|openai.*tool|llm.*(api|integration)|ai integration/ },
  { key: 'ai-agent', label: 'AI Agent / 工作助手', ai: true, ecosystem: 'ai-agent', pattern: /\bagent\b|assistant|claude code|\bcodex\b|ai coding|coding assistant|multi-agent|agentic/ },
  { key: 'content-training', label: '内容生产 / 培训', ai: true, ecosystem: 'content', pattern: /content generation|content creation|copywriting|presentation|slide deck|ppt|marketing|documentation|transcription|meeting notes|training|courseware|subtitle|video editor/ },
  { key: 'ai-media', label: 'AI 创作 / 多媒体', ai: true, ecosystem: 'ai-media', pattern: /\bai\b.*(voice|video|image|audio)|voice.*\bai\b|video.*\bai\b|text.to.speech|speech synthesis|lip.?sync|image generation/ },
  { key: 'product-tool', label: '协作 / 效率工具', ai: false, ecosystem: 'product', pattern: /self-hosted|open source alternative|calendar|note.?taking|productivity|collaboration|project management|file management|customer support/ },
  { key: 'creative', label: '创意 / 视觉体验', ai: false, ecosystem: 'creative', pattern: /design|animation|visuali[sz]ation|canvas|3d|music|game|creative/ },
  { key: 'developer-tool', label: '开发效率 / CLI', ai: false, ecosystem: 'developer-tool', pattern: /\bcli\b|terminal|developer tool|code search|static analysis|testing|debug|git |api client|automation/ }
];

function classifyRepo(repo) {
  const text = `${repo.fullName || ''} ${repo.description || ''}`.toLowerCase();
  const topic = TOPIC_DEFINITIONS.find(definition => definition.pattern.test(text))
    || { key: 'indie-product', label: '独立产品灵感', ai: false, ecosystem: 'indie-product' };
  return {
    ...repo,
    owner: repo.owner || String(repo.fullName || '').split('/')[0],
    topic: topic.key,
    topicLabel: topic.label,
    ecosystem: topic.ecosystem,
    isAi: topic.ai || /\b(ai|llm|gpt|claude|codex|gemini)\b/.test(text)
  };
}

function recentSemanticState(entries, policy, now) {
  const cutoff = now - policy.semanticCooldownDays * 24 * 60 * 60 * 1000;
  const ownerCutoff = now - policy.ownerCooldownDays * 24 * 60 * 60 * 1000;
  const recentEntries = entries.filter(entry => Number.isFinite(Date.parse(entry.sentAt)) && Date.parse(entry.sentAt) >= cutoff);
  const recentOwners = new Set(entries
    .filter(entry => Number.isFinite(Date.parse(entry.sentAt)) && Date.parse(entry.sentAt) >= ownerCutoff)
    .map(entry => entry.owner || String(entry.fullName || '').split('/')[0])
    .filter(Boolean));
  return {
    recentTopics: new Set(recentEntries.map(entry => entry.topic).filter(Boolean)),
    recentEcosystems: new Set(recentEntries.map(entry => entry.ecosystem).filter(Boolean)),
    recentOwners
  };
}

function takeFreshDiverse(repos, limit) {
  // Group by topic for diversity, then pick round-robin by highest starsToday
  const groups = new Map();
  for (const repo of repos) {
    const topic = repo.topic || 'other';
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(repo);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => b.starsToday - a.starsToday || b.stars - a.stars);
  }
  const selected = [];
  while (selected.length < limit) {
    const activeGroups = [...groups.values()]
      .filter(group => group.length > 0)
      .sort((a, b) => b[0].starsToday - a[0].starsToday || b[0].stars - a[0].stars);
    if (activeGroups.length === 0) break;
    for (const group of activeGroups) {
      if (selected.length >= limit) break;
      selected.push(group.shift());
    }
  }
  return selected;
}

function buildShortlists(repos) {
  const normalized = repos.map(repo => classifyRepo({ ...repo, periods: normalizePeriods(repo) }));
  const freshCandidates = normalized.filter(repo => repo.periods.some(period => period === 'daily' || period === 'weekly'));
  const monthlyCandidates = normalized.filter(repo => repo.periods.includes('monthly'));
  const weeklyCandidates = normalized.filter(repo => repo.periods.includes('weekly'));
  const fresh = takeFreshDiverse(freshCandidates, FRESH_SHORTLIST_LIMIT);
  const monthly = [...monthlyCandidates]
    .sort((a, b) => b.stars - a.stars || b.starsToday - a.starsToday)
    .slice(0, EVERGREEN_SHORTLIST_LIMIT);
  const weeklyFallback = [...weeklyCandidates]
    .sort((a, b) => b.stars - a.stars || b.starsToday - a.starsToday)
    .slice(0, EVERGREEN_SHORTLIST_LIMIT);
  return {
    freshNames: new Set(fresh.map(repo => repo.fullName)),
    monthlyNames: new Set(monthly.map(repo => repo.fullName)),
    weeklyFallbackNames: new Set(weeklyFallback.map(repo => repo.fullName)),
    counts: { fresh: fresh.length, monthly: monthly.length, weeklyFallback: weeklyFallback.length }
  };
}

function buildPools(repos, excludeList, historyState, now, shortlists) {
  const entries = historyState?.entries || [];
  const freshBlocked = namesInCooldown(entries, FRESH_COOLDOWN_DAYS, now);
  const evergreenBlocked = namesInCooldown(entries, EVERGREEN_COOLDOWN_DAYS, now);
  // Keep the existing name cache as the authoritative legacy dedup layer.
  // The timestamped state adds semantic cooldowns; it must not reopen old names.
  for (const name of excludeList) {
    freshBlocked.add(name);
    evergreenBlocked.add(name);
  }
  if (!historyState) {
    console.error('[github-digest] History state missing: using legacy name cache until the first successful migration');
  }
  const normalized = repos
    .filter(repo => repo.owner !== 'sponsors' && repo.fullName)
    .map(repo => classifyRepo({ ...repo, url: `https://github.com/${repo.fullName}`, periods: normalizePeriods(repo) }));
  const fresh = normalized.filter(repo => shortlists.freshNames.has(repo.fullName) && !freshBlocked.has(repo.fullName));
  const monthlyEvergreen = normalized.filter(repo => shortlists.monthlyNames.has(repo.fullName) && !evergreenBlocked.has(repo.fullName));
  const monthlyNames = new Set(monthlyEvergreen.map(repo => repo.fullName));
  const weeklyFallback = monthlyEvergreen.length < MIN_EVERGREEN_POOL
    ? normalized
      .filter(repo => shortlists.weeklyFallbackNames.has(repo.fullName) && !evergreenBlocked.has(repo.fullName) && !monthlyNames.has(repo.fullName))
      .sort((a, b) => b.stars - a.stars || b.starsToday - a.starsToday)
      .slice(0, MIN_EVERGREEN_POOL - monthlyEvergreen.length)
    : [];
  return {
    fresh,
    evergreen: [...monthlyEvergreen, ...weeklyFallback],
    monthlyEvergreenCount: monthlyEvergreen.length,
    weeklyFallbackCount: weeklyFallback.length,
    freshBlocked: freshBlocked.size,
    evergreenBlocked: evergreenBlocked.size
  };
}

function compareCandidatePriority(a, b, semanticState) {
  const score = repo => {
    const topicFreshness = semanticState.recentTopics.has(repo.topic) ? 0 : 2;
    const ecosystemFreshness = semanticState.recentEcosystems.has(repo.ecosystem) ? 0 : 1;
    return topicFreshness + ecosystemFreshness;
  };
  return score(b) - score(a) || b.starsToday - a.starsToday || b.stars - a.stars;
}

function pickDiverseCandidates(candidates, limit, policy, semanticState, selected, allowRecentOwners = false) {
  const picked = [];
  const selectedTopics = new Map(selected.map(repo => [repo.topic, 1]));
  let aiCount = selected.filter(repo => repo.isAi).length;
  const available = (allowRecentOwners ? candidates : candidates.filter(repo => !semanticState.recentOwners.has(repo.owner)))
    .sort((a, b) => compareCandidatePriority(a, b, semanticState));

  for (const repo of available) {
    if (picked.length >= limit) break;
    if (selected.some(item => item.fullName === repo.fullName)) continue;
    if (selected.some(item => item.owner === repo.owner)) continue;
    if ((selectedTopics.get(repo.topic) || 0) >= policy.maxPerTopic) continue;
    if (repo.isAi && aiCount >= policy.maxAiProjects) continue;
    picked.push(repo);
    selected.push(repo);
    selectedTopics.set(repo.topic, (selectedTopics.get(repo.topic) || 0) + 1);
    if (repo.isAi) aiCount++;
  }
  return picked;
}

function selectDiverseDigest(pools, preferences, historyState, now) {
  const policy = normalizeDiversityPolicy(preferences);
  const semanticState = recentSemanticState(historyState?.entries || [], policy, now);
  const selected = [];
  let ownerFallback = false;

  // Pass 1: strict owner cooldown (avoid recent owners)
  let fresh = pickDiverseCandidates(pools.fresh, FRESH_SELECTION_LIMIT, policy, semanticState, selected, false);
  let evergreen = pickDiverseCandidates(pools.evergreen, EVERGREEN_SELECTION_LIMIT, policy, semanticState, selected, false);
  let distinctTopics = new Set([...fresh, ...evergreen].map(repo => repo.topic)).size;

  // Pass 2: if topic diversity insufficient, relax owner cooldown to fill missing topics
  if (fresh.length + evergreen.length < MIN_TOTAL_RECOMMENDATIONS || distinctTopics < policy.minDistinctTopics) {
    const beforeCount = fresh.length + evergreen.length;
    const beforeTopics = distinctTopics;
    selected.length = 0;
    fresh = pickDiverseCandidates(pools.fresh, FRESH_SELECTION_LIMIT, policy, semanticState, selected, true);
    evergreen = pickDiverseCandidates(pools.evergreen, EVERGREEN_SELECTION_LIMIT, policy, semanticState, selected, true);
    distinctTopics = new Set([...fresh, ...evergreen].map(repo => repo.topic)).size;
    ownerFallback = true;
    console.error(`[github-digest] Owner cooldown fallback: before=${beforeCount} projects, ${beforeTopics} topics; after=${fresh.length + evergreen.length} projects, ${distinctTopics} topics`);
  }

  const finalCount = fresh.length + evergreen.length;
  if (finalCount < MIN_TOTAL_RECOMMENDATIONS || distinctTopics < policy.minDistinctTopics) {
    const message = `Diversity gate failed: selected=${finalCount}, topics=${distinctTopics}/${policy.minDistinctTopics}`;
    if (policy.allowReducedDigest && finalCount >= MIN_TOTAL_RECOMMENDATIONS) {
      throw new Error(`${message}. Reduced digest cannot satisfy the minimum topic coverage.`);
    }
    throw new Error(message);
  }
  return {
    fresh: fresh.map(repo => ({ ...repo, pool: 'fresh' })),
    evergreen: evergreen.map(repo => ({ ...repo, pool: 'evergreen' })),
    policy, semanticState, ownerFallback
  };
}

function formatCandidates(repos) {
  return repos.map(repo => {
    const unit = GROWTH_UNIT[resolvePrimaryPeriod(repo)] || '星/周';
    const rawGrowth = repo.starsToday || 0;
    const safeGrowth = rawGrowth > (repo.stars || 0) * 0.8 ? 0 : rawGrowth;
    return [
      `项目：${repo.fullName}`,
      `主题：${repo.topicLabel}`,
      `描述：${repo.description || '（暂无描述）'}`,
      `语言：${repo.language || 'Unknown'}｜热度：+${safeGrowth} ${unit}｜总星数：${repo.stars || 0}`
    ].join('\n');
  }).join('\n\n');
}

function buildEditorialPrompt(kind, repos, preferences) {
  const isFresh = kind === 'fresh';
  const title = isFresh ? '今日新星' : '经典常青树';
  const specialRule = isFresh
    ? '项目与主题已由程序完成质量筛选。不得改变、替换、增删或重新归类项目；只需把它们写成让企业 AI 项目负责人和运营人员愿意阅读的编辑内容。'
    : '项目与主题已由程序完成质量筛选。不得改变、替换、增删或重新归类项目；突出成熟项目仍可借鉴的产品思路。';
  return `你是 GitHub 每日盲盒的编辑。下面是已经确定的「${title}」项目，必须逐个且仅对这些项目撰写内容。

阅读者画像：
${preferences.readerProfile}

严格规则：
1. 只能使用下方已确定的 fullName，不能编造、不能引用额外项目。
2. 先输出一段开场文字（仅「今日新星」需要），然后严格按候选列表顺序输出每个项目块。不要输出其他标题、候选池说明、思考过程或道歉。
3. 每个项目块以候选项目标注的主题作为三级标题，格式：### ⚡ 主题名。
4. 每个项目块格式：
   **[owner/repo](https://github.com/owner/repo)** · ⭐ 总星数 · 📈 +数字 单位
   然后用三个独立段落介绍，每段一句完整中文，约 70-100 个汉字，分别说明：它是什么、适合什么业务场景、如何迁移到团队或企业内部。每个项目末尾写「🔥 +数字 单位」热度标记，单位必须与候选池标注一致。
5. ${specialRule}
6. 不得出现「没有好项目」「候选不足」「无法推荐」等拒绝语。

已确定的${title}项目：
${formatCandidates(repos)}`;
}

async function callLLM(systemPrompt) {
  loadEnv({ path: ENV_PATH });
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) throw new Error('Missing ANTHROPIC_AUTH_TOKEN. 请在项目根目录 .env 文件或 GitHub Actions Secrets 中配置。');
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';
  const requestBody = {
    model,
    max_tokens: 16384,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请生成符合全部格式要求的项目内容。' }
    ]
  };
  if (/aliyuncs\.com|dashscope/.test(baseUrl)) requestBody.enable_thinking = true;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) throw new Error(`API error (${response.status}): ${await response.text()}`);
  const result = await response.json();
  return result.choices?.[0]?.message?.content?.trim() || '';
}

function extractProjectNames(text) {
  const names = [];
  const linkPattern = /\[[^\]]+\]\(https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) names.push(match[1].replace(/\/$/, '').split(/[?#]/)[0]);
  return names;
}

function validateSelection(text, allowedNames, expectedCount) {
  const names = extractProjectNames(text);
  const unique = [...new Set(names)];
  if (!text || /没有好项目|候选不足|无法推荐/.test(text)) return { valid: false, reason: 'contains refusal text' };
  if (names.length !== expectedCount || unique.length !== expectedCount) return { valid: false, reason: `expected ${expectedCount} unique links, got ${names.length}/${unique.length}` };
  const invalid = unique.filter(name => !allowedNames.has(name));
  if (invalid.length > 0) return { valid: false, reason: `projects outside pool: ${invalid.join(', ')}` };
  return { valid: true, names: unique };
}

async function writeSelection(kind, repos, preferences) {
  if (repos.length === 0) return { text: '', names: [] };
  const allowedNames = new Set(repos.map(repo => repo.fullName));
  for (let attempt = 1; attempt <= MAX_POOL_GENERATION_ATTEMPTS; attempt++) {
    const text = await callLLM(buildEditorialPrompt(kind, repos, preferences));
    const validation = validateSelection(text, allowedNames, repos.length);
    if (validation.valid) return { text, names: validation.names };
    console.error(`[github-digest] ${kind} generation attempt ${attempt} rejected: ${validation.reason}`);
  }
  throw new Error(`${kind} generation failed validation after ${MAX_POOL_GENERATION_ATTEMPTS} attempts`);
}

async function rewriteSelection(kind, selection, expectedCount) {
  if (expectedCount === 0) return selection;
  const allowedNames = new Set(selection.names);
  const title = kind === 'fresh' ? '今日新星' : '经典常青树';
  const prompt = `请扩写下面的「${title}」内容以提高邮件篇幅。严格保留原有 ${expectedCount} 个 Markdown 链接和品类分组标题（### ⚡ 品类名），不得新增、删除或替换项目链接，不得改变品类分组顺序。不要输出思考过程或候选池说明。每个项目仍用三个独立段落，每段为一句约 110-140 个汉字的完整中文，保留元信息行（⭐ 总星数 · 📈 +数字 单位）和末尾的🔥热度标记。\n\n原内容：\n${selection.text}`;
  for (let attempt = 1; attempt <= MAX_LENGTH_REWRITE_ATTEMPTS; attempt++) {
    const text = await callLLM(prompt);
    const validation = validateSelection(text, allowedNames, expectedCount);
    if (validation.valid) return { text, names: validation.names };
    console.error(`[github-digest] ${kind} length rewrite rejected: ${validation.reason}`);
  }
  return selection;
}

function composeDigest(today, fresh, evergreen, freshTarget, dataAgeHours) {
  const fallbackHeading = freshTarget < 4 ? '🏆 经典常青树补充' : '🏆 经典常青树';
  const freshSection = freshTarget > 0
    ? `## 🔥 今日新星\n\n${fresh.text}\n`
    : '## 📦 本期说明\n\n今日新星候选在 hardFilter 与 7 天冷却后不足，本期仅由经典项目补充推荐。\n';
  const evergreenSection = evergreen.text ? `\n## ${fallbackHeading}\n\n${evergreen.text}\n` : '';
  const ageNotice = dataAgeHours !== null && dataAgeHours >= 24 ? `⚠️ 数据非当日，源自 ${dataAgeHours} 小时前。\n\n` : '';
  return `# GitHub 每日盲盒 — ${today}\n\n${ageNotice}${freshSection}${evergreenSection}\n以上由 AI 从 GitHub Trending 自动筛选生成\n`;
}

function writeHistoryOutputs(args, selected) {
  function atomicWriteJson(filePath, value) {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, filePath);
  }
  if (args.historyOutput) {
    atomicWriteJson(args.historyOutput, selected.map(item => item.fullName));
    console.error(`[github-digest] History saved: ${selected.length} project names`);
  }
  if (args.historyStateOutput) {
    const sentAt = new Date().toISOString();
    const entries = selected.map(item => ({
      fullName: item.fullName,
      owner: item.owner,
      pool: item.pool,
      topic: item.topic,
      topicLabel: item.topicLabel,
      ecosystem: item.ecosystem,
      isAi: item.isAi,
      sentAt
    }));
    atomicWriteJson(args.historyStateOutput, { version: 1, entries });
    console.error(`[github-digest] History state saved: ${entries.length} timestamped entries`);
  }
  if (args.selectionOutput) {
    atomicWriteJson(args.selectionOutput, {
      version: 1,
      generatedAt: new Date().toISOString(),
      projects: selected.map(item => ({
        fullName: item.fullName,
        owner: item.owner,
        pool: item.pool,
        topic: item.topic,
        topicLabel: item.topicLabel,
        ecosystem: item.ecosystem,
        isAi: item.isAi,
        stars: item.stars,
        starsToday: item.starsToday,
        primaryPeriod: resolvePrimaryPeriod(item)
      }))
    });
    console.error(`[github-digest] Selection manifest saved: ${selected.length} projects`);
  }
}

async function main() {
  const args = parseArgs();
  const rawInput = await readStdin();
  if (!rawInput.trim()) throw new Error('输入数据为空，可能原始数据文件不存在或拉取失败');
  let data;
  try { data = JSON.parse(rawInput); } catch (error) { throw new Error(`输入数据不是有效 JSON: ${error.message}`); }
  if (data.status === 'error') throw new Error(`Trending fetch failed: ${data.message}`);
  if (!Array.isArray(data.repos) || data.repos.length === 0) throw new Error('Trending 数据没有项目');

  const preferences = loadPreferences();
  const { kept, dropped } = hardFilterRepos(data.repos.filter(repo => repo.owner !== 'sponsors'), preferences);
  console.error(`[github-digest] Input ${data.repos.length} repos → hard filter kept ${kept.length}, removed ${dropped.length}`);
  for (const item of dropped) console.error(`  ✗ ${item.repo.fullName} — ${item.reason}`);
  const shortlists = buildShortlists(kept);
  console.error(`[github-digest] Shortlists: fresh=${shortlists.counts.fresh}/${FRESH_SHORTLIST_LIMIT}, evergreen monthly=${shortlists.counts.monthly}/${EVERGREEN_SHORTLIST_LIMIT}, weekly fallback=${shortlists.counts.weeklyFallback}/${EVERGREEN_SHORTLIST_LIMIT}`);
  const historyState = loadHistoryState(args.historyStateFile);
  const pools = buildPools(kept, args.excludeList, historyState, Date.now(), shortlists);
  console.error(`[github-digest] Pools: fresh=${pools.fresh.length} (blocked=${pools.freshBlocked}, target ≥20); evergreen=${pools.evergreen.length} (monthly=${pools.monthlyEvergreenCount}, weekly fallback=${pools.weeklyFallbackCount}, blocked=${pools.evergreenBlocked})`);
  if (pools.fresh.length < 20) console.error(`[github-digest] Warning: fresh pool below acceptance target (${pools.fresh.length}/20)`);

  const now = Date.now();
  const selection = selectDiverseDigest(pools, preferences, historyState, now);
  console.error(`[github-digest] Diversity selection: fresh=${selection.fresh.length}, evergreen=${selection.evergreen.length}, topics=${new Set([...selection.fresh, ...selection.evergreen].map(repo => repo.topic)).size}/${selection.policy.minDistinctTopics}, AI=${[...selection.fresh, ...selection.evergreen].filter(repo => repo.isAi).length}/${selection.policy.maxAiProjects}, ownerFallback=${selection.ownerFallback}`);

  if (args.dryRun) {
    console.log(JSON.stringify({
      fresh: selection.fresh,
      evergreen: selection.evergreen,
      policy: selection.policy,
      ownerFallback: selection.ownerFallback
    }, null, 2));
    return;
  }

  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  let fresh = await writeSelection('fresh', selection.fresh, preferences);
  let evergreen = await writeSelection('evergreen', selection.evergreen, preferences);
  let digest = composeDigest(today, fresh, evergreen, selection.fresh.length, args.dataAgeHours);
  let bytes = Buffer.byteLength(digest, 'utf8');
  if (bytes < MIN_DIGEST_BYTES) {
    // 先重写较短的池
    const rewriteFresh = selection.evergreen.length === 0 || Buffer.byteLength(fresh.text, 'utf8') <= Buffer.byteLength(evergreen.text, 'utf8');
    if (rewriteFresh) fresh = await rewriteSelection('fresh', fresh, selection.fresh.length);
    else evergreen = await rewriteSelection('evergreen', evergreen, selection.evergreen.length);
    digest = composeDigest(today, fresh, evergreen, selection.fresh.length, args.dataAgeHours);
    bytes = Buffer.byteLength(digest, 'utf8');
    // 如果还不够，再重写另一个池
    if (bytes < MIN_DIGEST_BYTES) {
      if (rewriteFresh) evergreen = await rewriteSelection('evergreen', evergreen, selection.evergreen.length);
      else fresh = await rewriteSelection('fresh', fresh, selection.fresh.length);
      digest = composeDigest(today, fresh, evergreen, selection.fresh.length, args.dataAgeHours);
      bytes = Buffer.byteLength(digest, 'utf8');
    }
  }
  const selected = [...selection.fresh, ...selection.evergreen];
  if (selected.length < MIN_TOTAL_RECOMMENDATIONS || selected.length > MAX_TOTAL_RECOMMENDATIONS) {
    throw new Error(`Digest project count ${selected.length} is outside ${MIN_TOTAL_RECOMMENDATIONS}-${MAX_TOTAL_RECOMMENDATIONS}`);
  }
  if (bytes < MIN_DIGEST_BYTES) throw new Error(`Digest remained below ${MIN_DIGEST_BYTES} bytes after retrying both pools (${bytes} bytes)`);
  console.log(digest);
  console.error(`[github-digest] Digest generated successfully: ${selected.length} projects, ${bytes} bytes`);
  writeHistoryOutputs(args, selected);
}

main().catch(error => {
  console.error(`[github-digest] Error: ${error.message}`);
  process.exit(1);
});
