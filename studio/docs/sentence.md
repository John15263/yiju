# 一句：网页练习 + 可选 Codex 语音

`/` 是完整练习入口：粘贴原文 → Gemini 整理摘要、结构与逐句材料 → 用户确认 → 逐块（语音学习 → 默写）→ 整句试写 → Gemini 评分与反馈 → 下一句。网页通过 SSE 更新，Codex 可读取当前状态提供语音帮助，但无需用 Codex 启动。配置与生成接口见 [Gemini 配置](gemini.md)。网页不自动监听 Codex 消息或音频。

短语检查使用已有 TypeSafe key，见 [短语接口](phrases.md)。sentence brief 包含当前短语及已提交输入，供文字或语音讨论。旧填空接口保留以兼容历史记录。

## 日常用法

点击“新的想法”，粘贴聊天或写作、选择英语或日语，确认 Gemini 整理的摘要、结构和参考后逐块练习，每一块**先学、再默写**：屏幕显示这一块的中文意思和外语写法，按 ⌘ ] 后陪练直接开讲这一块的词义和语法结构（不要求跟读或复述，可随时插话提问），再按 ⌘ ↵（“开始默写”）收起外语，凭记忆写出来。这是为了让默写变成回忆刚学过的表达，而不是猜一个没见过的词。不想学可以点“我会了，直接默写”，不拦，但这一块会记为未学（`skipped`）。学过或跳过的块重练时直接进入默写。每块默写按 Command / Ctrl + Enter 检查，和参考一字不差就直接进入下一块，否则停在这一块看点评、听批改讲解，再按一次进入下一块；最后一块完成后进入整句。整句提交后由 Gemini 评分，超过 95 分自动进入下一句短语；也可手动完成后继续。提示会自动出现，Command + [ 可以手动逐级要，允许参考后继续；没有跳过短语直接写整句的入口，只有拆不出短语时例外。原文、分数、反馈与历史记录保留，最后一句完成后不循环。

反馈里的“你的表达”按批改方式呈现：用你的原句与本次返回的 `suggestion` 做词级对比，删去的部分标红划掉，建议换成的部分标绿。标记只来自这两段真实文本，不向模型索取错误位置，也不推断错误类型；完整建议、分数和历次尝试在“看完整点评”里。若建议表达与原句差别过大（保留下来的字不足四成），标题会说明这是改写而不是若干处订正。日语按词切分，同样逐词比较。

完成本轮不等于长期掌握。网页隐藏答案不能撤回旧聊天里已经看到的内容。试写过程中呈现过的帮助会保留在 attempt 的支持记录中，最终隐藏不抹掉它。

## CLI

在项目根目录操作。用户文本用文件传递，避免 shell 转义风险。运行文件可放在已忽略的 `studio/data/` 内。

```sh
npm run studio -- sentence state
npm run studio -- sentence list
npm run studio -- sentence new /absolute/path/material.json
npm run studio -- sentence command /absolute/path/command.json
```

新材料文件（这是示例，真实用户意思用 `origin: user_meaning`）：

```json
{
  "meaning": "我喜欢做饭，但也想保护好自己的双手。",
  "language": "en",
  "reference": "I enjoy cooking, but I also want to protect my hands.",
  "keywords": ["enjoy", "protect"],
  "frame": "I enjoy ___, but I also want to ___.",
  "explanation": "enjoy 后接 doing：enjoy cooking。want 后接 to + 动词原形：want to protect。but 连接两方面的考虑。",
  "origin": "demo"
}
```

`language` 为 en/ja；材料可由网页 Gemini 准备并经用户确认，也可由 Codex 根据用户意思准备。创建一条新的独立记录，原记录不覆盖；不因切换语言而自动翻译用户作品。

命令文件示例。`expected_revision` 必须来自最近读取的真实状态：

```json
{"expected_revision": 1, "type": "practice", "payload": {}}
```

CLI 添加 command_id；可在命令文件中提供固定 ID 用于同一请求重试，同时保持相同 revision 和 payload。内容变化必须使用新 ID。冲突需重新读状态并判断。

| 命令 | payload | 用途 |
|---|---|---|
| accept_preparation | `{"preparation_id":"待确认ID"}` | 原子建立材料、短语并开始练习 |
| repeat | `{}` | 在反馈/完成阶段保留旧轮，创建同材料的新轮 |
| start_phrases | `{}` | 开始或恢复短语阶段，每块先学再默写；旧材料按需生成拆解。学习→默写由 `POST /api/sentence/phrases/write` 切换 |
| practice | `{}` | 理解、学习、反馈或完成阶段开始新一次表达，默认无外语提示 |
| support | `{"level":0}` | 试写中的帮助：0 无、1 关键词、2 骨架、3 完整参考 |
| record_support | `{"text":"实际给出的帮助"}` | 记录 Codex 对话中给过的语言帮助 |
| study | `{}` | 回看示范，结束当前未提交试写窗口 |
| attempt | `{"text":"实际回答","source":"typed_original"}` | 保存原文并自动请求已配置的 Gemini；未配置时等待反馈 |
| feedback | `{"attempt_id":"实际ID","message":"短反馈","suggestion":"可选AI建议"}` | 给最新一次回答反馈；不覆盖原文 |
| complete | `{}` | 完成已反馈的一轮，不做掌握判定；点评有实际改动时先出改错小测（见 phrases.md“改错小测与 Anki”），小测没做完返回 409 |
| pause / resume | `{}` | 暂停或恢复原阶段 |
| select | `{"id":"已有一句ID"}` | 切换到已有记录 |

attempt 的 source 为 typed_original / user_revision / voice_transcript / simulation。修订可带 `parent_attempt_id`。AI 内容只能是 material/feedback/support。没有真实转写就不使用 voice_transcript。

## HTTP 与保存

沿用旧服务的同源、loopback、cookie/Bearer 校验，不向页面暴露 API key。

- `GET /api/sentence` 返回 revision、active、collection（独立单句为 null）、history、preparation、client_view。
- `POST /api/sentence/commands` 使用 `{command_id,expected_revision,type,payload}`。
- `GET /api/sentence/events` 初始和重连发送完整状态，之后推送变更。
- `POST /api/sentence/view-ack` 使用 `{rendered_revision}`，仅确认页面完成渲染。

SQLite 中独立 `sentence_board` 表持久化当前句子、各语言历史、真实产物、反馈、支持事件和命令去重信息，旧 sessions/decisions 不改动。当前版本为个人小规模原型，整个板状态作为一个 JSON 保存。浏览器只在示范阶段把整句参考和解释、在学某一块时把这一块的外语写法挂到 DOM；默写和试写阶段按选定帮助显示，旧回答和反馈也收起。数据仍在本机接口中，隐藏用于练习，不是防作弊边界。
