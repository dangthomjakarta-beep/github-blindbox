#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import tls from "node:tls";

const FEED_X_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json";
const FEED_PODCASTS_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json";
const FEED_BLOGS_URL =
  "https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json";

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

function buildPrompt(data) {
  return [
    {
      role: "system",
      content: [
        "你是 Follow Builders AI 简报编辑。",
        "你只可以使用用户提供的 JSON 内容写简报，不要访问网页，不要编造事实。",
        "每个被写入简报的项目都必须带原始 URL；没有 URL 的内容不要写。",
        "输出简体中文。技术名词如 AI、LLM、API、agent、prompt、token、GPU、CPU、RAG 保持英文。",
        "语气专业但口语化，像懂行的朋友在转述重点。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `请生成今天的中文 AI Builders Digest。日期：${beijingDateLabel()}`,
        "",
        "结构固定为：",
        "1. 标题：AI Builders Digest — 日期",
        "2. X / Twitter：只写有实质信息的 builder，每人 2-4 句，跳过闲聊、活动打卡和低信息量内容。",
        "3. 官方博客：每篇 100-250 字，先说核心公告或洞察，再说影响。",
        "4. Podcast：200-400 字，先写“核心 takeaway”，再写最值得记住的观点。",
        "",
        "硬性规则：",
        "- 不要写 Twitter handle 前面的 @。",
        "- 不要猜职位，只能使用 bio 或人名。",
        "- 每个条目都要保留 URL。",
        "- 不要把所有原文逐条翻译，要提炼成简报。",
        "- 如果某一类没有内容，就跳过该类。",
        "",
        "JSON 内容如下：",
        JSON.stringify(data, null, 2),
      ].join("\n"),
    },
  ];
}

async function generateDigest(data) {
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
      max_tokens: Number(env("MAX_DIGEST_TOKENS", "3500")),
      messages: buildPrompt(data),
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
  if (
    data.stats.xBuilders === 0 &&
    data.stats.podcastEpisodes === 0 &&
    data.stats.blogPosts === 0
  ) {
    console.log("No follow-builders content found. Nothing to send.");
    return;
  }

  console.log("Loaded follow-builders feed:", JSON.stringify(data.stats));
  const digest = await generateDigest(data);
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
