# Gemini 内容整理与整句审查

整句试写过程中的动态续写帮助见 [写作帮助](writing-help.md)：沿参考的提示使用本地材料，其他表达用同一个 Gemini 配置按当前草稿生成；提示与最终审查分别处理。

在项目根目录 `.env` 填写 `GEMINI_API_KEY=你的密钥`，然后重启 `npm start` 并刷新网页。`GEMINI_MODEL` 默认为 `gemini-3.8-flash`，可改成账号可用的模型；`GEMINI_TIMEOUT_MS` 默认为 30000，整理材料的 `GEMINI_PREPARATION_TIMEOUT_MS` 默认为 60000。API key 只在本机后端读取，不发送到浏览器，也不放进请求 URL。已有 Jev key 不需要修改。

网页“新的想法”可粘贴聊天或写作，选择英语/日语。Gemini 先整理中文摘要及核心、辅助逻辑和结构，再按内容生成 1–12 个逐句练习单元。每句说明作用、上下文关系和逐字原文依据，备好参考、关键词、语法解释和短语拆解。用户确认整段预览后才建立练习；未确认或生成失败不会覆盖当前练习。短语试写使用 Jev 检查，最后一块完成后进入整句。整句按 Command + Enter 提交后保存实际答案，并请求 Gemini 检查意思、语法和自然度。详见 [短语练习](phrases.md)。反馈标签会显示“Gemini 的反馈”，原始答案不被 AI 改写覆盖。

材料生成提示词保存在 [sentence-prepare.txt](../prompts/sentence-prepare.txt)。它要求忠于原文、分清聊天发言者、不补造因果或理由，保留立场、条件、程度与不确定性。句数由内容决定，未确定的含义单独列出供确认。每块附中文意思及结构、开头提示，完整参考可随时求助查看。后端验证结构、原文引文和所有短语对整句参考的完整覆盖；Jev 的检查任务仍由服务器固定定义，不执行生成文本中的指令。

实际评审提示词保存在 [sentence-review.txt](../prompts/sentence-review.txt)，修改后重启服务生效。要求接受合理变体、区分错误和可选润色、最多解释两个重点，允许向 Codex 求助，不因使用帮助扣分。帮助记录用来描述练习条件，不当作长期掌握的证据。

每次新的 Gemini 评审还必须返回 0–100 的整数 `score`，表示本次作品的表达完成度：原意与逻辑 50 分、语法结构 30 分、词汇自然度 20 分。可接受的不同措辞、可选润色和求助不扣分。网页显示分数，**超过 95 分（96–100）**时后端将本句标为完成，并在同一次保存中选择本段的下一句；95 分及以下留在反馈页供修改。下一句按原有阶段打开，新句从短语试写开始，已有草稿、提示和进度不重置。下一句顶部保留上一句分数，可展开查看原文、评语与建议。

“完成这一句”也会直接选择下一句，按钮在有后续单元时显示“完成并进入下一句”。最后一句或独立单句停在完成页，不循环或新建练习。历史无分数反馈仍可查看、手动完成，不补造分数，也不自动重新调用模型。分数缺失、不是整数或超出范围时本次评审失败，原答案保留、可主动重试，不触发切句。刷新和重复提交不重复推进。

材料生成会向 Google 发送本次粘贴的原文（最多 20,000 字符）、目标语言和补充重点（最多 2,000 字符）。后续整句审查发送当前句子的目标语言、中文原意、参考句、学习者整句答案、练习类型与帮助级别。成段练习还发送中文摘要、核心与辅助逻辑、本句作用及前后句中文意思，供判断衔接；不发送整段原始聊天、其他句子的答案或练习历史。评审只针对当前句子，不因没有写出其他句子而扣分。参考句不作为唯一正确答案，提示要求接受合理近义表达、区分错误与风格差异，不据填空声称独立掌握。

请求失败时保留原文，显示具体的中性提示和重试按钮；不自动反复收费重试。同一答案的并发请求合并，重复提交命令不再发起审查。切换题目、暂停或 Codex 已先反馈时，迟到的 Gemini 结果不覆盖现场。服务重启时，未完成审查标记为中断，不自动重放。

`POST /api/sentence/review` 接受 `{round_id, attempt_id, retry?}`，只允许当前等待反馈的最新答案，沿用同源与本地认证。请求体不接受自由 prompt、分数、API key 或自定义 URL。`GET /api/config` 只返回配置是否存在和模型名称。审查记录保存在本地 round.reviews；AI 反馈含 `provider: gemini`、模型版本与 `score`。自动切句后的 board.completion 提供上句反馈供页面展示，分数随原作品持久化。

调用 Google 官方 [generateContent API](https://ai.google.dev/api/generate-content)，使用[结构化输出](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)并在后端验证结果。REST 的 responseFormat.text.mimeType 使用 API 参考规定的 APPLICATION_JSON 枚举。没有额外 npm 依赖。自动测试使用模拟服务，不使用真实密钥、不产生实际模型费用；真实联通检查另行进行。

## 网页生成接口

`POST /api/sentence/prepare` 接受 `{request_id, source, language, focus?}`。返回 board 状态，后台生成通过原有 SSE 发布；`preparation.status` 为 pending / ready / error / accepted。一个生成请求进行中不接受第二个，重复 ID 和相同正文复用结果；失败只允许主动以新 ID 重试，重启不会重放调用。原文和预览持久化，刷新能恢复。浏览器编辑中的原文草稿另存本机 localStorage。

`accept_preparation` 命令 payload 为 `{preparation_id}`，沿用 command_id 和 expected_revision。确认时先验证所有单元，再一次写入整段结构与全部逐句练习，记录来源、模型、原文和确认时间；无效或过期预览不产生练习。返回的 `collection` 含 outline、按顺序排列的 units 和 active_index；各 round 保留 collection_id、unit.index、role、purpose、connection 和 source_quotes。上下句切换使用现有 select 命令，不把 AI 材料记作用户回答。`repeat` 建立当前句的新一轮，保留旧轮和帮助记录，清空新轮输入和提示；整段导航指向该句最新一轮。之前保存的单句预览仍可确认。

网页整句试写使用既有 `attempt` 命令，首次为 typed_original，后续修订用 user_revision 和 parent_attempt_id；HTTP 层对 attempt 和 cloze_submit 都自动请求 Gemini。CLI 直接走此 HTTP 接口时行为相同；已有 Gemini 反馈时 Codex 不重复写入。

## 思考级别

所有文字调用都带 `thinkingConfig.thinkingLevel`，由 `GEMINI_THINKING_LEVEL` 决定，默认 `low`；留空则用模型自己的默认（3.8-flash 默认 medium）。2026-09-23 实测同一条短语提示：默认 6.8 秒、思考 1,311 个 token；low 为 1–3 秒、思考 0 个。整理材料和整句点评也一并用 low，若质量不够可以单独调回。

## 用量与花费

每次 Gemini 调用（REST 与 Live）都按 Google 随回复返回的 `usageMetadata` 记入 SQLite 的 `usage_log` 表：时间、用途、模型、所属句子（语音有）、文字/音频输入、文字/音频输出、思考 token 和按官方价格算出的美元数。价格表在 `studio/server/usage.mjs`，出处是 [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)（2026-09-23 读取）；思考 token 按输出价计，未扣除缓存折扣，所以数字可能略高；表里没有的模型只记 token、不给价。没通过校验的回复（如被截断）照样计入，因为 Google 同样收费。

用途：材料整理、旧句拆解、短语检查、短语提示（按键 / 停顿自动分开）、中文语序、整句写作提示、整句点评、改错小测判定、提示朗读、讲解稿（学习 / 批改）、讲解朗读、语音讲解、批改讲解、语音陪练（试写）。

Live 每一轮只在 `turnComplete` 时返回一次 `usageMetadata`，其中的输入已经包含之前整段对话（包括陪练自己说过的音频），这就是这一轮的计费量，整段会话的花费等于各轮之和。2026-09-23 用真实 key 实测：每轮约有 2,600 个模型自带的文字 token；陪练上一轮的音频会计入下一轮的输入；3 秒静音不计入。会话中页面每轮更新一次实际花费，结束时写进 `voice_session` 的 `usage`。

`GET /api/usage`（同源、本机认证）返回今天、近 7 天、累计的调用次数与花费，以及近 7 天按用途的明细；网页在“更多 → 练习记录与设置 → Gemini 花费”显示。账单以 AI Studio 为准。
