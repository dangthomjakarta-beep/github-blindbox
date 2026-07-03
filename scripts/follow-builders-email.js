#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import tls from "node:tls";

const FEED_X_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json";
const FEED_PODCASTS_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json";
const FEED_BLOGS_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json";
const PROMPTS_BASE_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts";
const PROMPT_FILES = {
  digestIntro: "digest-intro.md",
  summarizePodcast: "summarize-podcast.md",
  summarizeTweets: "summarize-tweets.md",
  summarizeBlogs: "summarize-blogs.md",
  translate: "translate.md",
};

function loadLocalEnv() {
  if (!existsSync(".env")) return;
  const text = readFileSync(".env", "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...valueParts] = line.split("=");
    if (process.env[key]) continue;
    let value = valueParts.join("=").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key.trim()] = value;
  }
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function truncate(value, maxChars) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadOfficialPrompts() {
  const entries = await Promise.all(
    Object.entries(PROMPT_FILES).map(async ([key, filename]) => {
      try {
        return [key, await fetchText(`${PROMPTS_BASE_URL}/${filename}`)];
      } catch (error) {
        console.warn(`Could not load official prompt ${filename}: ${error.message}`);
        return [key, ""];
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function loadFollowBuildersData() {
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL),
  ]);

  const maxTweetsPerBuilder = Number(env("MAX_TWEETS_PER_BUILDER", "5"));
  const maxBlogChars = Number(env("MAX_BLOG_CHARS", "7000"));
  const maxTranscriptChars = Number(env("MAX_TRANSCRIPT_CHARS", "32000"));

  const x = (feedX.x || []).map((builder) => ({
    name: builder.name,
    handle: builder.handle,
    bio: builder.bio,
    tweets: (builder.tweets || []).slice(0, maxTweetsPerBuilder).map((tweet) => ({
      text: tweet.text,
      url: tweet.url,
      createdAt: tweet.createdAt,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
    })),
  }));

  const podcasts = (feedPodcasts.podcasts || []).slice(0, 1).map((podcast) => ({
    name: podcast.name,
    title: podcast.title,
    url: podcast.url,
    publishedAt: podcast.publishedAt,
    transcript: truncate(podcast.transcript, maxTranscriptChars),
  }));

  const blogs = (feedBlogs.blogs || []).map((blog) => ({
    name: blog.name,
    title: blog.title,
    url: blog.url,
    publishedAt: blog.publishedAt,
    author: blog.author,
    description: blog.description,
    content: truncate(blog.content, maxBlogChars),
  }));

  return {
    generatedAt: new Date().toISOString(),
    feedGeneratedAt:
      feedX.generatedAt || feedPodcasts.generatedAt || feedBlogs.generatedAt || null,
    stats: {
      xBuilders: x.length,
      totalTweets: x.reduce((sum, builder) => sum + builder.tweets.length, 0),
      podcastEpisodes: podcasts.length,
      blogPosts: blogs.length,
    },
    x,
    blogs,
    podcasts,
  };
}

function beijingDateLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date());
}

function buildPrompt(data, prompts) {
  const officialPrompts = Object.entries(prompts || {})
    .filter(([, content]) => content)
    .map(([key, content]) => `### ${key}\n${content.trim()}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "你是 Follow Builders AI 简报主编，理念是 follow builders, not influencers。",
        "你的任务不是翻译信息流，而是按官方 prompt 的精神，筛选真正有原创观点、产品变化、研究进展或实操价值的内容。",
        "读者是中文 AI 工具使用者、产品/运营/业务负责人和想跟进 AI 产业变化的忙碌专业人士。",
        "你只可以使用用户提供的 JSON 内容写简报，不要访问网页，不要编造事实。",
        "每个被写入简报的项目都必须带原始 URL；没有 URL 的内容不要写。",
        "输出简体中文。技术名词如 AI、LLM、API、agent、prompt、token、GPU、CPU、RAG 保持英文。",
        "语气专业但口语化，像懂行的朋友在早会上转述重点。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `请生成今天的中文 AI Builders Digest。日期：${beijingDateLabel()}`,
        "",
        "请按下面结构输出。不要机械罗列，要先判断重要性，再解释为什么值得读。",
        "",
        "官方项目 prompt（必须遵守其筛选和写作原则）：",
        officialPrompts || "官方 prompt 暂时无法获取；请严格按 follow builders, not influencers 的原则执行。",
        "",
        "1. 标题",
        "格式：AI Builders Digest — 日期",
        "",
        "2. 今日一句话",
        "用 1 句话概括今天最值得注意的 AI 变化。如果当天内容很少，要直接说明“今天有效信号不多”。",
        "下一行写：数据源更新时间：feedGeneratedAt 对应的时间。如果 feedGeneratedAt 为空，写“数据源更新时间：未提供”。",
        "",
        "3. 今天最重要的 3-5 个信号",
        "每个信号使用这个格式：",
        "- 信号：一句话说清楚发生了什么。",
        "  为什么重要：说明它对 AI 产品、模型能力、agent、开发工具或业务落地的影响。",
        "  原始链接：URL",
        "优先选择跨来源反复出现、来自 builder 原创观点、官方产品/研究变化、能影响实际使用方式的内容。",
        "",
        "4. Builder 动向",
        "只写有实质信息的 builder。每人 2-4 句，说明这个人在想什么、做什么、发布了什么、或表达了什么判断。",
        "跳过闲聊、活动打卡、纯转发、营销口号和低信息量内容。",
        "作者身份只能来自 JSON 里的 bio 或人名，不要猜职位。",
        "每个 builder 至少保留一个原始 tweet URL。",
        "",
        "5. 官方博客 / 产品 / 研究更新",
        "每篇 100-250 字。先说核心公告或洞察，再说具体影响。",
        "如果有数字、限制、API、产品能力变化、研究结论，要写出来。",
        "每篇必须带原文 URL。",
        "",
        "6. Podcast 深度 takeaway",
        "如果有 podcast，写 200-400 字。",
        "先写“核心 takeaway”，再写最值得记住的观点。",
        "不要写成节目介绍，要写成你已经听完后给忙碌读者的提炼。",
        "必须带视频 URL。",
        "",
        "7. 今天可以忽略的噪音",
        "用 2-4 条说明哪些类型的内容被你主动跳过，例如活动寒暄、泛泛宣传、重复观点。",
        "如果 JSON 中没有明显噪音，就写“今天没有明显需要特别提醒的噪音”。",
        "",
        "8. 给读者的行动建议",
        "给 3 条具体建议。建议必须来自当天内容，而不是泛泛而谈。",
        "示例方向：值得试用的工具、值得保存的文章、值得继续观察的 builder、值得在工作中验证的 AI 用法。",
        "",
        "9. 来源说明",
        "最后追加一行：Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders",
        "",
        "硬性规则：",
        "- 不要写 Twitter handle 前面的 @。",
        "- 不要猜职位，只能使用 bio 或人名。",
        "- 每个事实性条目都要保留 URL。",
        "- 没有 URL 的内容不要写。",
        "- 不要把所有原文逐条翻译，要提炼成简报。",
        "- 不要编造原文没有的发布时间、数字、产品名、观点或结论。",
        "- 不要因为某个来源被特别提到就强行展示；只按内容价值筛选。",
        "- 如果某一类没有内容，就跳过该类，但保留整体结构的关键部分。",
        "- 总长度控制在 1200-2200 个中文汉字左右，宁可少写低价值内容，也不要凑篇幅。",
        "- 排版适合手机邮件阅读：短段落、清晰小标题、少用长句。",
        "",
        "JSON 内容如下：",
        JSON.stringify(data, null, 2),
      ].join("\n"),
    },
  ];
}

async function generateDigest(data, prompts) {
  const apiKey = env("ANTHROPIC_AUTH_TOKEN") || env("DEEPSEEK_API_KEY");
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_AUTH_TOKEN or DEEPSEEK_API_KEY");
  }

  const baseUrl = env("ANTHROPIC_BASE_URL", "https://api.deepseek.com/v1").replace(
    /\/$/,
    "",
  );
  const model = env("ANTHROPIC_MODEL", env("DEEPSEEK_MODEL", "deepseek-chat"));
  const url = `${baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: Number(env("MAX_DIGEST_TOKENS", "6000")),
      messages: buildPrompt(data, prompts),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DeepSeek API error ${res.status}: ${truncate(text, 1000)}`);
  }

  const payload = JSON.parse(text);
  const digest = payload.choices?.[0]?.message?.content?.trim();
  if (!digest) {
    throw new Error(`DeepSeek returned no digest: ${truncate(text, 1000)}`);
  }
  return digest;
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function normalizeRecipients(value) {
  return String(value)
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dotStuff(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

async function sendSmtpMail({ fromEmail, toEmails, subject, body }) {
  const host = env("SMTP_HOST", "smtp.qq.com");
  const port = Number(env("SMTP_PORT", "465"));
  const authCode = requiredEnv("QQ_SMTP_AUTH_CODE");
  const fromName = env("MAIL_FROM_NAME", "AI Builders Digest");

  const socket = tls.connect({
    host,
    port,
    servername: host,
    rejectUnauthorized: true,
  });

  let buffer = "";
  let currentLines = [];
  const responses = [];
  let waiter = null;

  function flushWaiter() {
    if (waiter && responses.length > 0) {
      const next = responses.shift();
      const resolve = waiter.resolve;
      clearTimeout(waiter.timer);
      waiter = null;
      resolve(next);
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex + 1).replace(/\r?\n$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      currentLines.push(line);
      const match = line.match(/^(\d{3})([ -])/);
      if (match && match[2] === " ") {
        responses.push({
          code: Number(match[1]),
          lines: currentLines,
        });
        currentLines = [];
        flushWaiter();
      }
    }
  });

  function readResponse() {
    if (responses.length > 0) return Promise.resolve(responses.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error("SMTP response timeout"));
      }, 30000);
      waiter = { resolve, reject, timer };
    });
  }

  async function expect(codePrefix, command) {
    if (command) socket.write(`${command}\r\n`);
    const response = await readResponse();
    const codeText = String(response.code);
    const ok = Array.isArray(codePrefix)
      ? codePrefix.some((prefix) => codeText.startsWith(String(prefix)))
      : codeText.startsWith(String(codePrefix));
    if (!ok) {
      throw new Error(
        `SMTP expected ${codePrefix}, got ${response.code}: ${response.lines.join(" | ")}`,
      );
    }
    return response;
  }

  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  try {
    await expect(220);
    await expect(250, "EHLO github-actions");
    await expect(334, "AUTH LOGIN");
    await expect(334, Buffer.from(fromEmail).toString("base64"));
    await expect(235, Buffer.from(authCode).toString("base64"));
    await expect(250, `MAIL FROM:<${fromEmail}>`);
    for (const toEmail of toEmails) {
      await expect([250, 251], `RCPT TO:<${toEmail}>`);
    }
    await expect(354, "DATA");

    const headers = [
      `From: ${encodeHeader(fromName)} <${fromEmail}>`,
      `To: ${toEmails.join(", ")}`,
      `Subject: ${encodeHeader(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      `Date: ${new Date().toUTCString()}`,
    ];
    socket.write(`${headers.join("\r\n")}\r\n\r\n${dotStuff(body)}\r\n.\r\n`);
    await expect(250);
    await expect(221, "QUIT");
  } finally {
    socket.end();
  }
}

async function main() {
  loadLocalEnv();

  const data = await loadFollowBuildersData();
  const prompts = await loadOfficialPrompts();
  if (
    data.stats.xBuilders === 0 &&
    data.stats.podcastEpisodes === 0 &&
    data.stats.blogPosts === 0
  ) {
    console.log("No follow-builders content found. Nothing to send.");
    return;
  }

  console.log("Loaded follow-builders feed:", JSON.stringify(data.stats));
  const digest = await generateDigest(data, prompts);
  const subject = env("MAIL_SUBJECT", `AI Builders Digest - ${beijingDateLabel()}`);

  if (env("DRY_RUN") === "1") {
    console.log(digest);
    return;
  }

  const fromEmail = requiredEnv("QQ_EMAIL");
  const toEmails = normalizeRecipients(env("MAIL_TO", fromEmail));
  await sendSmtpMail({
    fromEmail,
    toEmails,
    subject,
    body: digest,
  });
  console.log(`Sent AI Builders Digest to ${toEmails.join(", ")}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
