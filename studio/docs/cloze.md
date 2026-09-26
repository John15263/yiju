# 逐空试写

Codex 预先准备题目、允许的表达与提示；网页输入后由本地后端自动检查。Enter、Tab 或离开当前输入框触发一次检查，打字期间仅保存草稿（约 450ms），不把半个单词判错。已知答案忽略首尾空白、连续空格及大小写后本地通过；其他表达发送到 TypeSafe Jev。一次空格可以填写多个词。

## 准备与切换

`sentence command FILE.json`，沿用 `expected_revision`。新命令：

- `prepare_cloze {segments}`：segments 中的字符串是固定文字，对象是一个空，包含 `id, answers, hints, role`。第一个 answer 必须与固定文字一起准确拼回当前 reference。hints 恰为三个字符串（中文意义、语法提示、首字母）；第四级自动显示参考答案。role 是供模型判断的固定上下文要求。整个模板最多 40 空；已存在模板不可覆盖。
- `start_cloze {}`：进入填空，保留已有填写与提示记录。
- `cloze_submit {source?}`：所有空非空后，保存用户拼出的实际整句到 attempts，进入 awaiting_feedback。source 默认 typed_original，测试用 simulation。允许未通过或未确定的空提交讨论。
- `practice {}`：从填空转入整句自由表达，不抹掉填空草稿。

例如 reference 为 `Show restraint.` 时，segments 可以是：

```json
["Show ", {"id":"restraint","answers":["restraint","self-control"],"hints":["克制自己","这里需要名词","参考词以 r 开头"],"role":"Noun meaning self-control, object of Show."}, "."]
```

`npm run studio -- sentence brief` 提供紧凑的现场状态：焦点空、已保存的各空输入、判断、提示级别和最新整句作品。`sentence state` 保留完整历史。此读取供 Codex 文字/语音讨论使用，网页不会自动发送消息或唤醒语音模型。

## 后端接口

均为 POST，沿用原同源 cookie/Bearer 校验；round_id 必须是当前激活且 stage=cloze 的一句。

| URL（前缀 /api/sentence/cloze/）| 请求 |
|---|---|
| input | round_id, slot_id, text, expected_version, edit_id |
| check | round_id, slot_id, expected_version, check_id, retry? |
| hint | round_id, slot_id, level（0–4）|
| focus | round_id, slot_id |

每空单独版本，输入变更立即使旧判断失效；异步结果应用前再检查句子、阶段、输入版本和请求。不同空可并行检查，最多 4 个 Jev 请求。相同输入结果缓存，并发重复请求合并；失败、模糊判断不自动付费重试，用户明确点“重新检查”才重试。服务重启将未完成判断变为待确认，不重放调用。

Jev 使用固定 choice 规范：accepted / spelling / form / meaning / review。返回值须通过结构、完整概率分布、confidence 和概率差门控，否则显示待确认。它判断当前输入替换到固定参考上下文是否合适，接受不同词数的合理同义表达，不自动生成解释；前端按类别显示预写提示。所有空组合后的整句由配置好的 Gemini 自动审查，或回到 Codex 讨论。

只发送当前答案、该句中文意思、目标语参考与本空规则，不发送整段聊天或历史作品。key 沿用 `.env` 中的 TYPESAFE_API_KEY，仅在后端读取。网络/服务失败不会显示“答错”。API 判断不是可靠性保证，更不是能力评分。

## 记录

输入草稿、各次判断与提示级别存入 sentence_board 的 cloze；浏览器 localStorage 兜底未保存输入，断网时显示失败并保留输入。整句提交附带 cloze 快照和 support_events，标记 `evidence_scope: prompted_cloze`。看过答案再收起仍会保留帮助记录；AI 示例或修正不替换用户原话。

## 键盘与文字反馈（2026-09-21）

不自动提交。所有空填满后仍可修改，用 Command / Ctrl + Enter 或提交按钮保存整句并请求 Gemini 反馈。提交前保存草稿并等待已启动的逐空检查；待确认或可能错误的空也可以提交。

Command + ← / → 切换到前后一个空，光标放在目标空末尾，不全选已有内容；首尾不循环。普通左右键、Shift 与 Alt 方向键保持原生文字编辑行为。Enter 检查并前进，Tab 保持原生顺序，离开非空输入会检查。

Command + Enter（或 Ctrl + Enter）保存整句，与提交按钮共用同一路径。先保存尚未落库的输入，再提交一次；空项会定位到第一个未填空，不提交半句。输入法组合期间不触发提交，按住快捷键不重复提交。配置 Gemini 后自动审查并在网页显示反馈；未配置时到 Codex 说“写完了”即可，无需重复粘贴答案。两种方式都不会自动向当前 Codex 对话发送消息。

每空下方显示“检查拼写 / 检查词形 / 看看搭配 / 待确认 / 可以继续”等短文字，句子上方保留最近完成判断的详细说明，焦点移到下一空也不会把该说明换成空白。输入修改后该空旧结果失效。文字是后端根据 Jev 的分类及预写语法/意义提示组合，不是 Jev 自由生成解释。待确认也提供预写提示，并计入 support_events；可以继续不代表最自然的写法。

重新从空白练同一句时，创建同材料的新一句记录并准备原模板，不覆盖上一轮。历史选择器对相同意思、相同语言标记第几轮。

进入输入框自动显示至少一级中文意义提示；已有更高提示保留。Command + [（按物理 Slash 键识别，兼容 macOS 输出 ÷）或提示按钮逐级升级到语法、首字母、完整参考。连续按键按顺序执行，每次只升一级，长按不跳级，中文/日文组合输入期间不触发。提示使用既有服务端记录保存，不新增模型调用；隐藏提示不删除帮助记录。
