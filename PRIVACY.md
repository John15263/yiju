# 一句 隐私政策 · Privacy Policy

生效日期 / Effective date: 2026-09-27

一句是一个开源的语言练习工具（浏览器插件和本机服务），源代码在 https://github.com/John15263/yiju 。一句**没有开发者服务器**：不收集、不上传、不出售你的任何数据，没有统计、没有广告、没有追踪。下面写清楚它读取什么、存在哪里、会发给谁。

## 一句读取的内容

- **你输入或粘贴的内容**：想表达的中文、补充的重点、自由写作，以及你默写的短语和整句。
- **右键菜单**：只有在你选中网页上的一段文字、点「用一句练这段话」时，读取选中的这段文字。一句不读取网页的其他内容，也不在任何网页上运行脚本。
- **语音**：只在你打开语音陪练时使用麦克风，关掉即停止。
- **API key**：你在「服务与 key」里填写的服务商密钥。

## 存在哪里

全部只存在你自己的电脑上：插件版存在浏览器的插件存储里（朗读的音频缓存存在浏览器的 IndexedDB 里），本机服务版存在程序的 `studio/data/` 文件夹里。包括 API key、设置、练习记录（原文、整理出的材料、你写的内容、点评、讲解稿、语音对话的文字记录）、待推送的 Anki 卡片和模型用量。开发者看不到这些数据。卸载插件（或删除 `studio/data/` 文件夹）即全部删除。

## 会发给谁

为了提供功能，一句用**你自己的 API key**，把必要的内容直接发给**你在设置里选择的**服务商，不经过任何其他服务器：

| 功能 | 发送的内容 | 发给 |
|---|---|---|
| 整理材料 | 你的原文和补充的重点 | 你选的文字服务 |
| 短语检查、提示、整句点评、改错小测、讲解稿 | 这一句的中文意思、准备好的外语写法、你写的内容 | 你选的文字服务 |
| 朗读 | 要念的提示或讲解文字 | 选 Gemini 朗读时发给 Google；选「浏览器自带」时由浏览器自己的语音念（Microsoft Edge 的部分“自然”语音会把文字发给微软的服务合成） |
| 语音陪练 | 你的麦克风声音，以及当前这一句的相关内容 | 你选的语音服务 |
| Anki（可选，插件里默认关闭） | 改错小测做成的卡片 | 只发给你这台电脑上的 Anki（AnkiConnect，`127.0.0.1`） |

可选的服务商及其隐私政策：

- Google（Gemini API）：https://policies.google.com/privacy
- DeepSeek：https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html
- 阿里云百炼（通义千问 / Qwen）：https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud201902141711_54837.html

这些内容如何被服务商处理，适用该服务商的条款。一句不会把你的数据用于提供上述功能以外的任何目的，也不会转交给任何其他人。

## 未成年人

一句面向学习者。如果你未满 14 周岁，请在监护人的同意和指导下使用，并遵守你所选服务商对使用者年龄的要求。

## 变更与联系

本政策如有变更，会更新在这个页面并修改生效日期。有问题请在 https://github.com/John15263/yiju/issues 提出。

---

## English

一句 (Yiju) is an open-source language practice tool (a browser extension and a local server). **It has no developer server**: it does not collect, upload or sell any of your data, and has no analytics, ads or tracking.

**What it reads.** What you type or paste into it: what you want to say in Chinese, the points you want to stress, free writing, and the chunks and sentences you write from memory. With the right-click menu, only the text you selected on a page, when you choose “Practise this with Yiju”; it reads nothing else on any page and runs no script on any page. Your microphone only while you have a voice call open, and the API keys you enter in Settings.

**Where it is kept.** Only on your own computer: in the browser's extension storage (with cached speech audio in the browser's IndexedDB) for the extension, or the app's `studio/data/` folder for the local server — API keys, settings, practice records (your text, the prepared material, what you wrote, feedback, explanations, voice transcripts), Anki cards waiting to be pushed, and model usage. The developer cannot see any of it. Uninstalling the extension (or deleting `studio/data/`) deletes it all.

**Who receives it.** To provide its features, 一句 sends the necessary content, with **your own API key**, directly to **the providers you choose** in Settings — Google (Gemini API), DeepSeek, or Alibaba Cloud Model Studio (Qwen) — and to no one else: your text and focus for preparing the material; the sentence's meaning, the prepared wording and what you wrote for checks, hints, reviews, quizzes and explanations; the words to be read aloud when Gemini speech is chosen (with the browser's own voices chosen, the browser reads them — some of Microsoft Edge's “natural” voices send the text to Microsoft's service); your microphone audio and the current sentence's context during a voice call. Anki cards, if you turn that on, go only to Anki on your own computer (AnkiConnect at `127.0.0.1`). Each provider's own terms and privacy policy apply to what it receives. Your data is not used for any other purpose and is not transferred to anyone else.

**Children.** 一句 is meant for learners. If you are under 14, use it with your parent's or guardian's consent and guidance, and follow the age requirements of the provider you choose.

**Changes and contact.** Changes will be posted on this page with a new effective date. Questions: https://github.com/John15263/yiju/issues
