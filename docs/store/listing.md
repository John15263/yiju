# Edge 加载项商店上架资料

照着 Partner Center 的页面顺序排列，每一栏直接复制。图片都在这个文件夹里。流程和一题一样：新建扩展 → 上传包 → 依次填下面各页 → 点 Publish，在提交页填审核备注。

## 1. 上传包（Packages）

上传 `dist/yiju-extension-0.4.5.zip`（在仓库里运行 `node edge/build.mjs` 生成，也可以从 [Releases](https://github.com/John15263/yiju/releases) 下载）。

包里的 `edge/_locales/<语言>/messages.json` 决定了商店里**不能再改**的两项，每种语言一份：

| 语言 | 名称 | 简短描述 |
|---|---|---|
| zh_CN（默认） | `一句 · 把想说的话练成英语日语` | `从你想说的中文出发，练成英语或日语：逐块先学再默写、整句点评、改错小测、语音陪练，可推送 Anki。用你自己的 API key。` |
| en_US | `Yiju 一句 · Say it in English or Japanese` | `Turn what you want to say in Chinese into English or Japanese: learn it chunk by chunk, write it from memory, get feedback.` |

要改名称或简短描述，只能改 `_locales` 后提高版本号重新上传。简短描述最多 132 个字符（构建时会检查）。

## 2. 可用性（Availability）

- Visibility：Public
- Markets：所有市场（默认）

## 3. 属性（Properties）

- Category：**Productivity**（Edge 的分类里没有 Education）
- Website：`https://github.com/John15263/yiju`
- Support contact detail：`https://github.com/John15263/yiju/issues`
- Mature content：不勾

## 4. 隐私（Privacy）

### Single Purpose Description

```
Helps Chinese speakers practise saying their own ideas in English or Japanese: in the browser side panel it organises what the user wants to say, prepares the wording in small chunks to learn and then write from memory, reviews the whole sentence the user writes, and quizzes the mistakes, with an optional voice tutor and optional cards for the user's own Anki.
```

### Permission justification

| 权限 | 理由（英文，直接复制） |
|---|---|
| sidePanel | `The whole extension is shown in the browser side panel, next to the page the user is reading or writing on.` |
| storage | `Stores the user's settings (chosen AI providers and their own API keys), practice records, Anki cards waiting to be sent and usage counts locally in the browser. Nothing is sent to the developer.` |
| unlimitedStorage | `Practice records (the user's texts, prepared material, attempts, feedback and explanations) grow with every sentence practised, and spoken explanations are cached as audio in IndexedDB (capped at 150 MB) so replays cost nothing; together this can exceed the default local storage quota.` |
| contextMenus | `Adds one item, "Practise this with Yiju", to the right-click menu for selected text. When the user chooses it, the selected text is handed to the side panel as the text to practise. No script runs on any page.` |

Partner Center 里所有网站（Host）权限只有**一个**框，填这段（包括只在打开 Anki 时才申请的可选权限）：

```
All hosts are AI providers, contacted directly with the user's own API key and only when the user chooses them in Settings: generativelanguage.googleapis.com (Google Gemini: text, speech and voice); api.deepseek.com (DeepSeek: text); dashscope.aliyuncs.com and dashscope-intl.aliyuncs.com (Alibaba Cloud Model Studio / Qwen: text); *.maas.aliyuncs.com (Qwen voice over WebRTC at the user's own workspace address https://<workspace>.<region>.maas.aliyuncs.com, so the subdomain cannot be listed in advance). Optional host permissions http://127.0.0.1 and http://localhost are requested only when the user turns on Anki, to reach AnkiConnect of the user's own desktop Anki. No developer server is contacted and no script is injected into any website.
```

### Are you using remote code?

**No, I am not using remote code.**（所有代码都在包里；插件只和 AI 服务商交换数据，不下载代码。）

### Data usage

“What user data do you plan to collect” 建议勾选（和一题一样）：

- **Personal communications**：用户粘贴或写下的内容（可能是自己的聊天、邮件）会发给他选的 AI 服务商；语音陪练时麦克风的声音也会发过去。
- **Website content**：只有用户在网页上选中文字、右键「用一句练这段话」时，那段文字才会进入一句并发给服务商。
- **Authentication information**：用户的 API key 存在本机，并作为凭证发给对应的服务商。

下面三条声明都可以如实勾选：不出售给第三方；不用于和核心功能无关的目的；不用于判断信用或放贷。

### Privacy Policy URL

```
https://github.com/John15263/yiju/blob/main/PRIVACY.md
```

## 5. 商店页面（Store listings）

包里有两种语言，商店页各填一份：**Chinese (Simplified)** 和 **English (United States)**。两种语言都用下面的图；一种语言传好之后，可以用图下面的 “Duplicate … for all languages” 复制到另一种语言。截图要一张一张按顺序传（传好后不能拖动排序）。

### 图片

| 栏位 | 文件 |
|---|---|
| Extension logo（必填） | `logo-300.png` |
| Small promotional tile | `tile-440x280.png` |
| Large promotional tile | `tile-1400x560.png` |
| Screenshots（按顺序） | `screenshot-1.png` 整理 · `screenshot-2.png` 逐块先学 · `screenshot-3.png` 默写和检查 · `screenshot-4.png` 整句点评 · `screenshot-5.png` 服务与 key |

截图里练的是一句自带的示例（学做饭的一段话，我们自己写的），在无痕的浏览器里用 Gemini 实际跑出来的。

### Description（中文）

```
一句帮你把自己想说的话练成英语或日语。练的永远是你自己想表达的内容，不是课本上的句子。

【它怎么练】
· 先整理：粘贴一段聊天、写作或想法（也可以在网页上选中一段文字，右键「用一句练这段话」），一句先整理出中文的核心意思和结构，再准备对应的英语或日语表达，拆成几小块。
· 逐块先学再默写：每一块先看表达、听讲解——词义、搭配、语法，一行一行念给你听；看懂了就遮住，凭记忆写出来，马上检查哪里错了、为什么、怎么改。
· 整句重写：最后自己把整句写出来，拿到改好的写法、分数和中文点评。
· 改错小测：写错的地方再做一次填空小测，也可以推送到 Anki 以后复习（可选）。
· 语音陪练：卡住时开口问，陪练用中文讲词义、搭配和语法。

【怎么用】
1. 点工具栏上的一句图标（绿色圆点），侧边栏打开，会弹出「服务与 key」。
2. 选服务商，填你自己的 API key：在中国大陆，一个阿里云百炼的 key 就够了（文字用千问，语音用 Qwen-Omni，需要填业务空间 ID，朗读用浏览器自带的声音）；在海外，一个 Google Gemini 的 key 就能跑全套。文字也可以用 DeepSeek。
3. 点「放一段示例」，或者粘贴你自己的内容，选英语或日语，点「整理我的想法」。

【隐私】
没有开发者服务器，没有统计和广告。key 和学习记录只存在你的浏览器里，内容只发给你选的 AI 服务商。一句是开源软件（AGPL-3.0）：https://github.com/John15263/yiju
```

### Description（English）

```
Yiju (一句, "one sentence") helps Chinese speakers turn what they want to say into English or Japanese. You always practise your own words, not textbook sentences. The interface is in Chinese.

How it works
• Organise first: paste a chat message, a piece of writing or an idea (or select text on any page and right-click "Practise this with Yiju"). Yiju sets out the core meaning and structure in Chinese, prepares the English or Japanese wording and splits it into small chunks.
• Learn each chunk, then write it from memory: see the wording and hear a line-by-line explanation of vocabulary, collocations and grammar; then hide it, write it yourself, and get an immediate check of what is wrong, why, and how to fix it.
• Rewrite the whole sentence: write it yourself at the end and get a corrected version, a score and feedback in Chinese.
• Quiz on mistakes: what you got wrong comes back as a fill-in-the-blank quiz, and can optionally be sent to your own Anki.
• Voice tutor: when stuck, just ask; it explains in Chinese.

How to use
1. Click the Yiju icon (a green dot) in the toolbar. The side panel opens with Settings.
2. Choose providers and enter your own API key: Google Gemini (one key covers everything), Alibaba Cloud Model Studio (Qwen; one key covers text and voice, a workspace ID is needed for voice), or DeepSeek for text.
3. Click "放一段示例" (insert an example) or paste your own text, choose English or Japanese, and click "整理我的想法" (organise my idea).

Privacy
There is no developer server, no analytics and no ads. Your key and learning records stay in your browser; content is sent only to the AI provider you choose. Yiju is open source (AGPL-3.0): https://github.com/John15263/yiju
```

### Search terms（最多 7 个，每个 ≤30 字）

- 中文：`英语学习` `日语学习` `英语写作` `外语表达` `语言学习` `语音陪练` `Anki`
- English：`English writing` `learn Japanese` `language learning` `writing practice` `Chinese speakers` `voice tutor` `Anki`

## 6. 审核备注（Notes for certification）

审核员多半在海外，用 Gemini 最方便。给他们一个 **Google Gemini 的 API key**：在一题审核用的那个已经设了 $2 月上限的项目（yiti-review）里再建一个 key（比如叫 `yiju-edge-reviewer`），这样花费仍然封顶，审核通过后单独删掉。把 key 填到下面的 `PASTE_KEY_HERE` 处（用尖括号 `<KEY>` 时，Partner Center 的输入框吞掉过它后面的换行）。不需要任何账号。

```
The extension works on its own; no account is needed. The interface is in Chinese, so labels are quoted with a translation.

1. Click the Yiju icon (a green dot) in the toolbar. The side panel opens and shows Settings (服务与 key).
2. Under 文字 (text) choose "Gemini", under 语音陪练 (voice) "Gemini Live", under 朗读 (speech) "Gemini 朗读". Paste this test key into "Gemini API key": PASTE_KEY_HERE
   Click "保存并测试" (save and test); all three lines should show "✓ 可用" (available). Click "关闭" (close).
3. Click "放一段示例" (insert an example), then "整理我的想法" (organise my idea). After about 15 seconds the organised Chinese and the English wording appear; click "确认并开始" (confirm and start).
4. The first chunk is shown. Click "听讲解" (listen to the explanation) to hear it explained line by line. Click "开始默写" (write from memory), type the English, then "检查" (check) to get a correction.
5. "问问题 · Ctrl ]" (ask a question) starts the voice tutor. If the side panel cannot ask for the microphone, the extension opens a small tab to grant it once. "结束" (end) stops the call.
6. On any web page, select some text, right-click and choose "用一句练这段话" (Practise this with Yiju): the side panel opens with that text.

All model calls go directly from the extension to the provider chosen in Settings, with the user's own key; there is no developer server and no script is injected into web pages. DeepSeek and Alibaba Cloud Model Studio (Qwen) are alternative providers for the same features, run through the same code; the Gemini key above covers text, speech and voice, so no other key is needed. Anki is optional and off by default: it needs the desktop Anki app with AnkiConnect, and access to 127.0.0.1 is requested only when it is turned on. The key exists only for this review and will be deleted afterwards.
```
