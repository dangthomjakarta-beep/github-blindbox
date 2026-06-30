#!/usr/bin/env node

// ============================================================================
// GitHub 每日盲盒 — AI Digest Generator
// ============================================================================
// Reads trending repo data from stdin, uses LLM to filter & categorize,
// outputs a human-readable digest.
//
// Usage: cat trending-feed.json | node github-digest.js > digest.txt
// ============================================================================

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Parse args --------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let excludeList = [];
  let historyOutput = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude-file' && i + 1 < args.length) {
      try {
         const content = readFileSync(args[i + 1], 'utf-8');
        excludeList = JSON.parse(content);
        if (!Array.isArray(excludeList)) excludeList = [];
      } catch (err) {
        console.error(`[github-digest] Warning: could not read exclude file: ${err.message}`);
      }
      i++;
    } else if (args[i] === '--history-output' && i + 1 < args.length) {
      historyOutput = args[i + 1];
      i++;
    }
  }
  return { excludeList, historyOutput };
}

// -- Read stdin --------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) { chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- Build prompt ------------------------------------------------------------

function buildPrompt(data, excludeList) {
  let repos = data.repos || [];

  // Remove previously sent projects
  const excludeSet = new Set(excludeList);
  const initialCount = repos.length;
  repos = repos.filter(r => !excludeSet.has(r.fullName));

  // Normalize URLs: always use https://github.com/owner/repo regardless of
  // what the API returned (some APIs return github.com/sponsors/owner etc.)
  repos = repos.map(r => ({ ...r, url: `https://github.com/${r.fullName}` }));

  // Filter out any remaining sponsors entries (unresolved or slipped through)
  const beforeFilter = repos.length;
  repos = repos.filter(r => r.owner !== 'sponsors');
  if (repos.length < beforeFilter) {
    console.error(`[github-digest] Filtered ${beforeFilter - repos.length} unresolved sponsors entries`);
  }

  // Compute exclusion count after all filtering (so the prompt is accurate)
  const excludedCount = initialCount - repos.length;
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  // Roughly categorize recent excludes for the "yesterday diversity" hint
  const yesterdayHint = (() => {
    const recent = excludeList.slice(-12);
    if (recent.length < 3) return '';
    let toolCount = 0, aiCount = 0, creativeCount = 0, otherCount = 0;
    for (const name of recent) {
      const lower = name.toLowerCase();
      if (/(ai|llm|gpt|chat|voice|speech|tts|stable.diffusion|transl|agent|mcp|skill)/.test(lower)) {
        aiCount++;
      } else if (/(game|art|animat|fun|play|pixel|terminal|novel|font|theme|3b1b|manim|godot)/.test(lower)) {
        creativeCount++;
      } else if (/(sync|cli|export|download|scraper|exporter|pars|convert|editor|link|manager|monitor|file|note|blog|email|form|cv|resume|pdf|pocketbase)/.test(lower)) {
        toolCount++;
      } else {
        otherCount++;
      }
    }
    const parts = [];
    if (toolCount) parts.push(`效率工具 ${toolCount} 个`);
    if (aiCount) parts.push(`AI 产品 ${aiCount} 个`);
    if (creativeCount) parts.push(`创意好玩 ${creativeCount} 个`);
    if (otherCount) parts.push(`其他 ${otherCount} 个`);
    return `\n📅 昨天推送品类分布：${parts.join('、')}。今天请尽量调换口味，不要和昨天高度重复。\n`;
  })();

  let repoList = '';
  for (const repo of repos) {
    repoList += `\n## ${repo.fullName}
- 描述: ${repo.description}
- 语言: ${repo.language}
- 总星数: ${repo.stars}
- 今日新增: ${repo.starsToday}
- Fork: ${repo.forks}
- 链接: ${repo.url}
`;
  }

  return `今天的日期是 ${today}。以下是从 GitHub Trending 今日列表中抓取到的热门项目。
${excludedCount > 0 ? `\n注意：今天原始数据共 ${initialCount} 个项目，其中 ${excludedCount} 个已排除（历史去重 + 数据过滤），剩余 ${initialCount - excludedCount} 个待筛选。` : ''}

你的任务是从这些项目中筛选出**真正值得关注**的，然后生成一封邮件正文。

## 阅读者画像（请结合此画像筛选项目）

- 独立开发者，vibecoding 实践者，Windows 用户
- Claude Code + Codex 主力工具
- 有产品思维和运维思维
- 喜欢「能直接用的」和「有意思的」

## 排除项（除非对 vibecoding 有直接帮助）

- 翻墙/代理工具
- 纯底层技术、算法库、编程语言、Web 框架
- 纯智能体/编码代理框架（多智能体框架、coding agent SDK、agent 工具箱等）：
  → 如果卖点是「拿过来直接当你的开发工具用」——除非破 10 万星或当下极火爆，否则跳过
  → 如果卖点是「产品形态、架构设计、理念上有参考价值」——保留，用来启发产品思路
- MCP 工具、Skill 集合、提示词工程等「直接能用」的 AI 周边 → 保留

## 加权信号（同类项目内部排序用）

- ⭐ 总星数高 → 经过了市场验证（加分）
- 🔥 今日增量大 → 当前热度高（加分）
- ⏳ 连续多日出现在 trending 上 → 持续火爆，加分更多
- ✨ 新奇感 → "这个没想到"（额外加分）

${yesterdayHint}

## 邮件结构

### 第一部分：🏆 经典常青树

从原始数据中挑选 **2 个总星数高、久经考验的老牌项目**，但要注意：**不要选底层技术类**（如算法库、Web框架、编程语言等）。

将选出的 2 个项目归类到以下三类中展示（每类最多 1 个，三类不一定都出现）：
- 🛠 效率工具类：能解决具体问题的成熟工具
- 🤖 AI 产品类：AI 相关且经过市场验证的项目
- 🎨 创意/好玩类：有趣有新意且广受欢迎的项目

每个项目用 2-3 句话介绍：做什么、为什么值得了解、当前星数。

### 第二部分：🔥 今日新星

筛选今日值得关注的项目。按以下品类组织展示，类型尽量不重复，但不强求凑数：

#### 🎨 创意/好玩类（最有意思的排最前面）
不是为了有用，而是有趣、好看、有新意——游戏、艺术、新奇实验等。每段写清楚「有意思在哪」。

#### 🛠 效率工具类
开箱即用解决具体问题——文件处理、自动化、效率提升等。每段写清楚「解决了什么问题」。

#### 🤖 AI 产品类
以 AI 为核心、上手能玩的产品——AI 助手、绘图、语音、翻译等。每段写清楚「用 AI 做了什么、普通人怎么用」。

#### 📊 数据/金融类
出彩的才放进来，不硬塞。

### 数量指导
🔥 今日新星部分目标 **5-8 个项目**：
- 优先保证质量，挑不到 8 个可以下探，但不要低于 5 个
- 如果候选池确实不够，可以适当放宽星数门槛或选一些品类独特的项目来补齐
- 宁可挑 5 个真正好的，也不要为凑数塞进 8 个重复或没亮点的

## 输出要求

1. 标题以 "# GitHub 每日盲盒 — ${today}" 开头
2. 开场白写一段简短介绍（1-2句话），指出今天最值得关注的一个趋势或方向
3. 每个项目用 2-4 行中文介绍，说人话——**不要技术术语**，假设读者不懂编程
4. 每个项目必须包含可点击的 Markdown 链接：**[项目名](链接地址)**，不要只写 "🔗 项目链接" 这种文字
5. 总体长度控制在 2000-4000 字
6. **经典常青树和今日新星两部分的项目不要重复**
7. 末尾附上一句 "以上由 AI 从 GitHub Trending 自动筛选生成"

## 原始数据

${repoList}

请开始生成。`;
}

// -- Call LLM (OpenAI-compatible) --------------------------------------------

async function callLLM(systemPrompt) {
  loadEnv({ path: join(homedir(), '.follow-builders', '.env') });

  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    throw new Error('Missing ANTHROPIC_AUTH_TOKEN. 请在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加这个 Secret。');
  }

  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';

  const url = `${baseUrl}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请生成今天的 GitHub Trending 精选。' }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error (${response.status}): ${errBody}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const rawInput = await readStdin();

  if (!rawInput || !rawInput.trim()) {
    console.error('[github-digest] Error: 输入数据为空，可能原始数据文件不存在或拉取失败');
    console.log('# GitHub 每日盲盒\n\n今天数据暂未就绪，请稍后再试。');
    return;
  }

  let data;
  try {
    data = JSON.parse(rawInput);
  } catch (err) {
    console.error(`[github-digest] Error: 输入数据不是有效的 JSON (${err.message})`);
    console.error('[github-digest] 收到的内容前200字符:', rawInput.substring(0, 200));
    console.log('# GitHub 每日盲盒\n\n今天数据格式异常，请检查 trending-feed.json 是否完整。');
    return;
  }

  if (data.status === 'error') {
    console.error('Trending fetch failed:', data.message);
    process.exit(1);
  }

  const repos = data.repos || [];
  if (repos.length === 0) {
    console.log('# GitHub 每日盲盒\n\n今天未能获取到 Trending 数据，请稍后再试。');
    return;
  }

  console.error(`[github-digest] Processing ${repos.length} repos (${args.excludeList.length} excluded from history)...`);

  try {
    const systemPrompt = buildPrompt(data, args.excludeList);
    const digest = await callLLM(systemPrompt);
    console.log(digest);
    console.error('[github-digest] Digest generated successfully');

    if (args.historyOutput) {
      const selectedNames = [];

      const linkRegex = /\[([^\]]+)\]\(https:\/\/github\.com\/([^/]+\/[^/)\s]+)\)/g;
      let match;
      while ((match = linkRegex.exec(digest)) !== null) {
        selectedNames.push(match[2]);
      }

      const bareRegex = /\[([^\]]+\/[^\]]+)\]/g;
      while ((match = bareRegex.exec(digest)) !== null) {
        const name = match[1].trim();
        if (!selectedNames.includes(name)) {
          selectedNames.push(name);
        }
      }

      const unique = [...new Set(selectedNames)];
      writeFileSync(args.historyOutput, JSON.stringify(unique, null, 2));
      console.error(`[github-digest] History saved: ${unique.length} projects`);
    }
  } catch (err) {
    console.error(`[github-digest] Error: ${err.message}`);
    process.exit(1);
  }
}

main();