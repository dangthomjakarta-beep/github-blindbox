# GitHub 每日盲盒

每天 18:00，AI 自动从 GitHub Trending 筛选**真正值得关注的项目**，按「创意好玩 / 工具 / AI 应用」三类整理好，发到你 QQ 邮箱。

## 它解决了什么？

GitHub Trending 每天有几十个项目上榜，但大部分是底层技术库、算法实现、框架——**对独立开发者/产品思维的人来说，噪音太多了。**

这个工具用 AI 帮你过滤，只留下对你有用的：

- 🎨 **创意/好玩类** — 游戏、艺术、新奇实验
- 🛠 **工具类** — 文件处理、自动化、效率提升
- 🤖 **AI 应用类** — 普通人也能用的 AI 产品

## 怎么用

### 你只需要 3 样东西

| 需要准备 | 费用 | 时长 |
|---------|------|------|
| GitHub 账号 | 免费 | 5 分钟注册 |
| 阿里云百炼 API Key | 免费额度够用 | 3 分钟申请 |
| QQ 邮箱 SMTP 授权码 | 免费 | 2 分钟获取 |

**不需要：** 云服务器、海外手机号、域名、任何付费服务。

### 第 1 步：申请阿里云百炼 API Key

1. 打开 [阿里云百炼](https://bailian.console.aliyun.com/)
2. 注册/登录 → 进入「模型广场」
3. 找到 **DeepSeek-v4-flash** → 点击「开通服务」→「创建 API Key」
4. 复制 Key（格式 `sk-xxxx`），保存好

> 每月消耗约几毛钱到几块钱，免费额度基本够用。

### 第 2 步：获取 QQ 邮箱授权码

1. 登录 QQ 邮箱 → 设置 → 账户
2. 找到 **「POP3/IMAP/SMTP 服务」** → 点击「开启」
3. 按提示发短信验证 → 拿到 **16 位授权码**（不是你的 QQ 密码）

### 第 3 步：新建 GitHub 仓库

在你的 GitHub 上 **新建一个空仓库**（不勾选任何初始化选项），名字随意。

### 第 4 步：添加 Secret

进入你新建的仓库 → **Settings → Secrets and variables → Actions → New repository secret**，依次添加 3 个：

| Secret 名称 | 填什么 |
|-------------|--------|
| `ANTHROPIC_AUTH_TOKEN` | 阿里云百炼 API Key |
| `ANTHROPIC_MODEL` | `deepseek-v4-flash`（或你用的其他模型名） |
| `QQ_EMAIL` | 你的 QQ 邮箱 |
| `QQ_SMTP_AUTH_CODE` | QQ 邮箱授权码 |

### 第 5 步：创建 workflow 文件

在你仓库创建文件 `.github/workflows/digest.yml`，内容如下：

```yaml
name: GitHub 每日盲盒

on:
  schedule:
    - cron: '30 10 * * *'   # 每天 18:30 北京时间（错开数据抓取，确保最新）
  workflow_dispatch:

jobs:
  send:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 安装依赖
        run: cd scripts && npm install

      - name: 拉取最新 Trending 数据
        run: curl -sL -o trending-feed.json https://raw.githubusercontent.com/zhangxq0606-ctrl/github-blindbox/main/trending-feed.json

      - name: 生成摘要
        env:
          ANTHROPIC_AUTH_TOKEN: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          ANTHROPIC_BASE_URL: https://dashscope.aliyuncs.com/compatible-mode/v1
          ANTHROPIC_MODEL: ${{ secrets.ANTHROPIC_MODEL }}
        run: |
          cat trending-feed.json | node scripts/github-digest.js > /tmp/digest.txt

      - name: 发送邮件
        env:
          QQ_EMAIL: ${{ secrets.QQ_EMAIL }}
          QQ_SMTP_AUTH_CODE: ${{ secrets.QQ_SMTP_AUTH_CODE }}
        run: |
          cat /tmp/digest.txt | node scripts/send-email.js \
            --to "$QQ_EMAIL" \
            --subject "GitHub 每日盲盒 — $(date '+%Y-%m-%d')"
```

**注意：** 把 `zhangxq0606-ctrl` 改成我的 GitHub 用户名。

### 第 6 步：推送到你的仓库

```bash
# 克隆你的空仓库
git clone https://github.com/你的用户名/你的仓库名.git
cd 你的仓库名

# 把项目文件复制进来
# （把下载的 github-blindbox 文件夹里的所有内容复制进来）

git add .
git commit -m "init: GitHub 每日盲盒"
git push
```

### 第 7 步：测试

回到 GitHub 仓库 → 点击 **Actions** 标签 → 左边点 **GitHub 每日盲盒** → 右边点 **Run workflow** → 等 1-2 分钟 → 去 QQ 邮箱查收。

**搞定！之后每天 18:00 自动推送。**

## 怎么自定义

| 想改什么 | 怎么改 | 难度 |
|---------|--------|------|
| **筛选标准** | 编辑 `scripts/github-digest.js` 里的「阅读者画像」段落 | ★☆☆ 换几句话 |
| **推送时间** | 改 `digest.yml` 里的 `cron` 表达式 | ★☆☆ 改几个数字 |
| **推送邮箱** | 改 Secrets 里的 `QQ_EMAIL` | ★☆☆ 改一次 |
| **AI 模型** | Secrets 改 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL` | ★☆☆ 换两个值 |
| **分类方式** | 改 `github-digest.js` 里的 prompt 文字 | ★★☆ 改描述 |
| **追踪其他方向** | 改「阅读者画像」里的描述 | ★☆☆ 换一段话 |

## 原理

```
你的仓库（数据源）                       球友的仓库
─────────────────                       ─────────────────
GitHub Actions 每天抓取 Trending             自己的 workflow
    ↓                                         ↓
生成 trending-feed.json                  curl 你的 raw 数据
    ↓                                         ↓
commit 到仓库                            跑 github-digest.js
                                         (AI 筛选 + 邮件发送)
```

- 抓取是我干的，你只需要配 AI + 邮箱
- 全部跑在 GitHub Actions 上，零成本
- 不需要服务器，不需要任何海外服务

## 常见问题

**Q：每天能收到多少项目？**
A：AI 从 50-80 个候选项目中筛选，最终推送 6-9 个（经典 2 个 + 新星 6-7 个）。

**Q：收不到邮件怎么办？**
A：检查 Secrets 是否配置正确，特别是 `QQ_SMTP_AUTH_CODE` 是不是 16 位授权码。也可以手动 Run workflow 看报错日志。

**Q：可以用其他模型吗？**
A：可以。支持任何 OpenAI 兼容接口，改 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_MODEL` 两个 Secret 即可。