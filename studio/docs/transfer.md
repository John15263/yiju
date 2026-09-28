# 换个场合（迁移练习）

代码在 `server/transfer.mjs`（出题、判定、流程）和 `web/transfer.js`（页面），提示词是 `prompts/transfer-make.txt` 和 `prompts/transfer-check.txt`，测试在 `tests/transfer.test.mjs`。

## 想法

一段话里有少数几块"几乎只有一种地道说法"：固定搭配、动词短语、句式框架、日语文型。这几块叫**轴**。其余部分怎么说都行（small daily things / little chores / trivial stuff），叫**自由段**。

改错小测在同一句、同一语境里把改过的地方挖空，练的是记住这一句。迁移练习保留轴、换掉场合，看学习者能不能在新句子里把它再用出来。改错小测照旧保留。

## 1. 意义块上的轴

意义块（`phraseSchema`）在 `meaning / reference / hints` 之外有 `axis` 和 `axis_meaning`，比如 `be worn down by ＋某事` 和"被某事一点点耗尽、磨垮"。准备材料的两个提示词（`sentence-prepare.txt`、`phrase-prepare.txt`）说明了什么算轴：换一种说法意思就变了或者不地道了才算；每句最多两个，没有就留空。

`axisOf` 只保留外语词确实出现在这一块 reference 里的轴（允许原形和变形，比如 worn / wear）。模型编出来的、从别的块拿来的、或者没给的，都当作没有轴，不会让整份材料失败。旧记录没有这两项，也当作没有轴。

## 2. 挑哪个轴

学习者不用选，也不用标。每句从有轴的块里挑一个（`pickAxis`），看这一块让他费了多少劲：

| 优先级 | 依据 |
|---|---|
| 3 | 这一块检查时被改过（`result.verdict === 'adjust'`，或者做过改错小测） |
| 2 | 这一块要过提示，或者停下来等到了提示（输入框打开时自动出现的那一条不算） |
| 1 | 这一块有轴，但没卡过 |

同样优先的取靠前的一块。同一段话里别的句子已经练过的轴不再挑，但"清空重练一轮"的新一轮可以再练同一个轴。整句批改改了什么不计入：题目在整句写完之前就出好了。

## 3. 两轮

**第一轮，每句练完马上做一道。**顺序是：整句批改 → 改错小测（有的话）→ 这一句的迁移题 → 下一句。`finishRound` 遇到这一句有准备好的题，就先进入 `transfer` 阶段，答完再往下走。得分超过 95、自动通过的句子也一样。

**第二轮，整段练完再来一遍**（`secondRound`）。第一轮每个轴再出一道新题，最多 4 道：第一轮没过的先选，其次按优先级。顺序打乱。每道题带上第一轮的中文（`earlier`），新题要换场合，最好连形式也换一换；和第一轮一样的题会被拒收，这一轮就不出了。

**不让人等**：这一句的意义块一写完（进入整句试写），就开始出第一轮的题，整句试写和批改的时间都用来等它。其他句子都做完、手上这句的题也出好（或者这句本来就没有轴）时，开始出第二轮的题。出题期间什么都不存，题出好才写入一次，所以不会和学习者正在进行的操作撞版本。句子已经做完、题才到，这道题就不用了；出题失败就跳过这一轮，都不挡路。

## 4. 数据

第一轮的题放在这一句的 round 上（`r.transfer`），第二轮的放在段落上（`collection.transfer`）。两轮结构相同：

```json
{
  "id": "uuid", "round": 1, "status": "ready", "index": 0,
  "provider": "gemini", "model": "…", "created_at": "…", "reason": "manual",
  "items": [{
    "id": "uuid", "round_id": "…", "chunk_index": 1,
    "axis": "be worn down by ＋某事", "axis_meaning": "被某事一点点耗尽、磨垮",
    "chunk_meaning": "被琐碎小事搞得很累", "chunk_reference": "been worn down by small daily things.",
    "priority": 3, "trouble": "写成了「been worn out with …」，被改成「…」",
    "prompt": "连着加了一个月班，他整个人都被耗空了。",
    "example": "He's been worn down by a month of overtime.",
    "status": "open", "tries": 0, "inputs": [], "results": [],
    "hint_level": 0, "hints": [], "passed": null
  }]
}
```

- `status`：`ready` 是还有题要做，`done` 是做完或跳过，`failed` 是没出成（带 `message`）。
- `reason`：只有第一轮有，记的是这一句本来怎么结束（`manual` 或 `score`），答完题后照这个结束。
- `results` 每项是 `{ verdict, note, suggestion, by, at }`。
- 第二轮的 item 多 `earlier` 和 `first_item_id`，指向第一轮的那一道。

每次作答、要提示、跳过，都在这个轴所在的句子上记一条 `support_events`：`{ kind: 'transfer', detail: { transfer_id, item_id, round, axis, hint_level, try?, answer?, verdict?, hint?, skipped? } }`。进入第一轮时记一条 `transfer_start`。

## 5. 提示（不调用模型）

⌘ [ 或「提示」按钮，一次多给一条，最新的在最上面：

1. 「想想刚才『{chunk_meaning}』那里的说法。」
2. 原来那一块的外语写法：他看到的是轴在原句里怎么用，套到新句子里（换时态、人称、内容）还得自己完成。
3. 参考说法，也就是答案。

## 6. 判定

接口在 `/api/sentence/transfer/`：`answer`、`help`、`continue`、`skip`。本机服务版和插件版一样。

- 写的和参考说法一样（只差大小写和标点）：本地直接判对，不调用模型。
- 其他情况交给 `transfer-check`，返回 `verdict: axis | form | other | miss`、`note`、`suggestion`。note 不写出要练的外语词。
- `axis`：通过。没有要看的东西就直接进下一题，有 note 或改动就先显示，⌘ ↵ 继续。
- `form` / `miss`：显示 note，可以再答一次。两次都没过，就显示对照、参考说法和练的是哪个说法，⌘ ↵ 继续。
- `other`：意思对，不算错。显示 note，自动给第 1 级提示，请他用刚才的说法再说一次。第二次不管结果都算做完。
- 没配文字服务，或者这次判定失败：不判错，显示参考说法让他自己对照。

现在只能打字作答；语音作答还没做。

## 7. Anki

第一轮每道题做完（不管对错）都做一张卡，进同一个「一句 · 改错填空」笔记类型：正面是新场合的中文，下面是要打出来的整句（cloze），背面写练的说法、原来那一块和当时写的，标签「换个场合」。第二轮不做卡，免得同一个轴出好几张。

## 8. 怎么知道有没有用（还没做）

两周内，一半的段落练完后做迁移练习，另一半照旧只做改错小测（随机分）。一周后，两组都出一道新场合的迁移题，比较 `verdict = axis` 的比例。迁移组明显更高，就留作默认；差不多的话，就改成可选。支持记录里已经有每道题的结果，统计时从 `support_events` 的 `transfer` 读。
