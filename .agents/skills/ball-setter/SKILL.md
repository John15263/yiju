---
name: ball-setter
description: 在一句项目中用 Codex 对话配合本地网页进行一句话英语或日语练习。准备用户想表达的意思、显示示范或提示、保存真实回答、提供反馈与再次表达；也支持继续旧主题练习。用于摆球器、开始或继续一句练习、给提示、撤架与暂停。
---

项目根目录 `/Users/john/Documents/一句`。默认使用“一句”页面 `http://127.0.0.1:4317/`。默认由网页启动：粘贴内容 → Gemini 提炼并准备材料 → 用户确认 → 逐空或整句试写 → Gemini 反馈。Codex 用作可选语音陪练；用户明确在对话里准备/提交时仍可通过 CLI 协作。逐空填写在网页，由后端自动检查并调用 Jev。网页按钮不自动唤醒 Codex，也没有自动订阅此对话或麦克风。

首次操作读取 [一句话接口](../../../studio/docs/sentence.md)。从项目根目录运行 `npm run studio -- sentence state`；服务未运行时用 `npm start` 启动。自定义端口仅从配置读取，勿输出 `.env` 密钥。

## 一句的小循环

1. 用户提供中文意思并选择 en/ja。意思清楚就直接准备；缺少语言或关键含义时才澄清。尚未给内容时不把先前讨论中的示例当成用户练习。创建含中文意思、自然参考、关键词、骨架及简短解释的一句材料。AI 不增加用户未表达的事实。示例用 `origin: demo`，用户的意思用 `user_meaning`。
2. 用 `sentence new FILE.json` 写入材料，并在 Codex 内置浏览器打开本地页面。用户在这里讨论；用网页“我来试写”或 CLI `practice` 隐藏参考并开始一次表达。每次只练一种语言，另一语言建立独立的一句记录。
3. 求助时先读状态，按需调整 `support` 或在对话中给一小块帮助。凡对话中提供目标语言、解释或句子骨架，用 `record_support` 登记实际给出的帮助。进入试写后避免在对话里重发完整参考；网页隐藏无法撤回旧聊天消息，所以不称为严格无辅助测试。
4. 用户回答时先保存其原文 `attempt`，再生成 `feedback`，两次写入分别读取最新 revision。已有网页状态为 practice 时不要重置表达窗口。用户直接在 study 阶段提交答案时，先 `practice`、再 `support level:3` 保守记下原先可见参考，最后保存，不称为独立表达。
5. 反馈优先看意思、影响理解的错误和一个值得调整的地方；接受正确的不同表达。AI 建议放入反馈，绝不登记为用户回答。`practice` 开始修订，修订产物用 `user_revision` 并引用前一 attempt ID。用户完成后 `complete`，暂停则 `pause`；都不代表长期掌握。
6. 每次操作使用 `sentence state` 的 revision；命令文件明确写 `expected_revision`。遇到冲突重读并判断，不盲目重试。写入后检查状态和 `client_view.rendered_revision`；只有保存而无页面确认时，只报告已保存。浏览器确认不是用户已经阅读或理解的证据。

用户不需要听到 CLI 或接口细节，只需知道下一次要表达什么。材料、实际回答及反馈通过 UTF-8 JSON 文件传给 CLI，放在已忽略的 `studio/data/` 下；避免把用户文本拼接进 shell 命令。每次模拟验证用 `origin: demo`、`source: simulation`，优先隔离临时数据库。

文字回答用 `typed_original`，真实修订用 `user_revision`。仅在实际取得语音转写时用 `voice_transcript`；语音差异不单独作为发音或语法错误证据。没有答案时不替用户生成并保存一条回答。

## 旧主题练习

用户明确要继续原来的主题练习会话时，打开 `/legacy`，读 [原接口](../../../studio/docs/api.md) 与 [语音规则](../../../studio/policies/voice-policy.md)。`npm run studio -- list`、`brief SESSION_ID` 读取现有会话。旧 Jev 词块选择与新的填空判断分别运行。

## 逐空试写与语音配合

读取 [填空接口](../../../studio/docs/cloze.md)。确定参考句后，一次性准备 segments、每空可接受答案、语法/意义判据及三级提示，使用 `prepare_cloze`，再 `start_cloze`。模板必须准确拼回参考句，已存在模板不能覆盖用户草稿；不为逐字输入临时编排工具调用。

用户说“看这个空/第几个空”时，运行 `npm run studio -- sentence brief` 读取当前焦点、已保存输入、Jev 结果和提示使用情况。输入有短暂保存延迟，不猜测未取得的文字。语音解释要用 `record_support` 保存实际给出的帮助。不把 Jev 的概率当成正确率或用户能力分数；未知表达和低置信可回到当前对话讨论。

网页提交整句会自动追加一个 `prompted_cloze` 产物并进入 awaiting_feedback。若已配置 Gemini，会自动审查并写入带 `provider: gemini` 的反馈；见 [Gemini 配置](../../../studio/docs/gemini.md)。收到“填好了/帮我看看”时先读取实际产物与已有反馈：仍在等待时可用 `feedback` 写入 Codex 反馈；Gemini 已反馈时就在对话里继续解释，不重复保存答案，也不把 Gemini 反馈说成 Codex 生成。固定上下文中的逐空通过不保证组合后的整句自然，也不证明独立写作。自由生成用 `practice`，网页已有整句输入区和提交按钮。HTTP 提交 `attempt` 也会自动调用已配置的 Gemini。用户在 Codex 回答时先保存原文，再读取状态；Gemini 正在审查时等待其结果或解释已有反馈，避免重复保存或抢写反馈。

网页可用“新的想法”生成摘要、核心/辅助结构及多句材料，确认后通过“上一句 / 下一句”逐句练习；“清空重练一轮”只重练当前句并保留历史。无须 Codex 代为启动。sentence brief 的 collection 包含整段结构、本句序号及各句中文意思，可用于理解用户当前问题；不要在试写中主动朗读其他句子的外语参考。材料生成与用户确认的 provenance 保存在 round.preparation，不把 Gemini 整理的内容称作用户亲自写出的英语/日语。详情见 [Gemini 配置与网页入口](../../../studio/docs/gemini.md)。
