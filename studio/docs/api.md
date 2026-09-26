# 本地接口与数据

所有私有 API 要求本地 token。CLI 从 `studio/data/.local-token` 读取；网页通过同源 HttpOnly / SameSite=Strict cookie。仅监听 127.0.0.1，校验 Host、Origin、Content-Type；前端不持有 TypeSafe key。`GET /api/health` 只公开服务名与版本。

从项目根目录执行：

```sh
npm run studio -- list
npm run studio -- new ja
npm run studio -- brief SESSION_ID
npm run studio -- command SESSION_ID resume '{}'
npm run studio -- command SESSION_ID set_scaffold '{"meaning_support":"outline","language_support":"none"}'
npm run studio -- command SESSION_ID show_hint '{"hint_id":"sleep","explicit_help":true}'
npm run studio -- command SESSION_ID park '{"next_entry":"下次不用外语提示再说一次"}'
npm run studio -- export SESSION_ID
```

`SESSION_ID` 替换为 `list/new` 返回值。CLI 用 Node 24 内置 fetch；不需要安装依赖。脚本或工具可直接调相同 HTTP API。

| 路径 | 方法 | 内容 |
|---|---|---|
| `/api/packs` | GET | 固定授权练习包 |
| `/api/config` | GET | Jev 是否配置、模型 alias；无密钥 |
| `/api/sessions` | GET / POST | 列表 / `{pack_id,target_language}` 创建 |
| `/api/sessions/ID` | GET | 权威会话状态 |
| `/api/sessions/ID/brief` | GET | 本次简报与状态 |
| `/api/sessions/ID/commands` | POST | `{command_id,expected_revision,type,payload}` |
| `/api/sessions/ID/attempts` | POST | 追加产物，带 ID 和 expected_revision |
| `/api/sessions/ID/events` | GET | SSE；连接与重连发送完整状态 |
| `/api/sessions/ID/view-ack` | POST | `{rendered_revision}`；不增加 revision |
| `/api/sessions/ID/decisions/next` | POST | `{decision_id,expected_revision}`；不接受 prompt/criteria |
| `/api/sessions/ID/decisions` | GET | 全部追踪；再接 `/DECISION_ID` 取一条 |
| `/api/sessions/ID/export` | GET | Markdown 记录 |

命令：`resume`, `park {next_entry?}`, `set_scaffold {meaning_support?,language_support?}`, `show_hint {hint_id,explicit_help?}`, `hide_hint`, `apply_variant {variant_id}`, `hold_conditions {enabled}`, `set_mode {mode}`, `set_task {task_id}`, `save_draft {text}`, `begin_attempt`, `set_interaction {is_user_speaking?,user_control?,recent_input?}`, `record_spoken_support {text}`。字段白名单校验，未知键拒绝。

意义轴：full / outline / scene / none。语言轴：reference / chunks / keywords / none。cue ID：tea / caffeine / limit / late / sleep，按会话语言映射。变式：none / rephrase / clarify；一次替换一个条件。`set_task` 首版只允许 explain-choice。`set_mode` 支持 conversation / absorption / regenerate / adapt，是练习意图，不是能力评估。

Jev 示例（仅真实取得转写才使用 voice_transcript；测试须用 simulation）：

```sh
npm run studio -- command SESSION_ID set_interaction '{"user_control":"help","recent_input":{"text":"咖啡因，这个日语怎么说？","source":"control"}}'
npm run studio -- decide SESSION_ID
npm run studio -- traces SESSION_ID
```

recent_input 来源：typed_original / voice_transcript / control / simulation；不自动成为用户产物。user_control：help / no_hints / keep / pause / null。`is_user_speaking` 依赖用户或 Codex 显式登记，非实时音频检测。

产物文件示例：`{"text":"用户实际内容","source":"typed_original","user_confirmed":false}`，然后 `npm run studio -- attempt SESSION_ID /absolute/path/attempt.json`。可选 `parent_attempt_id` 引用前次产物。其他来源：voice_transcript、user_confirmed_text、user_revision、agent_summary、ai_suggestion、simulation。追加且去重，不覆盖历史。没有显式 begin_attempt 时，保守记录整个会话的支持历史，不自动认定独立表达。

SQLite 数据在 `studio/data/studio.sqlite`，凭据与数据目录被 Git 忽略。草稿经 debounce 保存至服务端，未保存文字以浏览器 localStorage 兜底；提示局部更新不替换编辑框。源码包与原典保持只读，运行产物独立。

Jev 请求按 [TypeSafe 官方契约](https://docs.typesafe.ai/api) 发送 `state + model + questions` 到 `https://api.typesafe.ai/v1/systemone`。只接受已登记 choice、完整概率分布、合法 confidence；应用前重验 revision、候选版本、停止/说话/保持条件、置信度与概率差、最短显示时间。重复 decision 不二次推理；并发新 ID 被拒绝；网络异常不自动重试收费请求。中途重启的 pending 记录转为升级，不自动重放。

门槛来自 `.env`，用于可逆提示的初始试用配置，非普遍真理。低置信、无输入、未配密钥或 ask_astra 只记录升级，服务端没有第二个 Astra 模型调用。decision 的 API 推理耗时与 `view-ack.save_to_ack_ms` 分开；后者包括 SSE、渲染和确认网络耗时，重连后的确认不等于持续在线的渲染延迟，更不证明用户已读。
