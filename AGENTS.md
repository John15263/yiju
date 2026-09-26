# 给 AI Agent 的安装说明

用户说"帮我装一句"时，**默认装浏览器插件版**：一个 Edge / Chrome 侧边栏插件，不需要常驻的服务，重启电脑后也照常能用。只有用户明确要本机服务版（想改代码、做开发，或要用旧版主题练习 `/legacy`）时，才走文末的「本机服务版」。不要改代码。

## 插件版

### 1. 拿到插件文件夹

有 Node 24 或更新（`node --version`），就在仓库里构建：

```sh
node edge/build.mjs    # 生成 dist/edge/，里面有 manifest.json
```

没有 Node 的话不用装，直接下载构建好的：到 https://github.com/John15263/yiju/releases 下载最新的 `yiju-extension-<版本>.zip`（有 `gh` 可以用 `gh release download --repo John15263/yiju --pattern '*.zip'`），解压到一个固定的位置，比如用户的「文稿」下的 `yiju-extension`。解压后的文件夹最外层应该直接有 `manifest.json`。

**注意**：要加载的是 `dist/edge` 或解压出来的文件夹。仓库里的 `edge/` 是源代码，不是插件（里面只有 `manifest.template.json`），选它会加载失败。

### 2. 加载插件（要用户自己点）

浏览器设置只能由用户操作。把插件文件夹的**绝对路径**告诉用户，然后请他们：

1. Edge 打开 `edge://extensions`（Chrome 打开 `chrome://extensions`），打开「开发人员模式」。
2. 点「加载解压缩的扩展」（Chrome 叫「加载已解压的扩展程序」），选那个文件夹。
3. 点工具栏上一句的图标（绿色小圆点；看不到的话先点拼图图标把它固定出来），侧边栏会打开。

### 3. 填 API key（用户在「服务与 key」里填）

侧边栏第一次打开会自动弹出「服务与 key」；以后在整理页下方，或者右上角「⋯ → 练习记录与设置」里都能打开。**让用户自己在那里粘贴 key**，不要让他们把 key 发到对话里。文字、语音陪练、朗读是分开选的：

- **在中国大陆**：一个阿里云百炼的 key 就够了。文字选「阿里云百炼（千问）」，语音选「阿里云百炼」，区域选「中国大陆（北京）」，**业务空间 ID 必填**（插件里的语音走 WebRTC，必须用业务空间的专属地址），朗读选「浏览器自带」。key 在 https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key ，区域选华北2（北京）；业务空间 ID 点控制台右上角的业务空间图标可以看到。文字也可以用 DeepSeek（https://platform.deepseek.com/api_keys）。
- **能用 Google 的话**：三项都选 Gemini，填一个 Gemini key（https://aistudio.google.com/apikey）。

填好后点「保存并测试」，文字、语音陪练、朗读三行都显示"✓ 可用"就好了；显示 ✗ 会写原因（key 不对、缺业务空间 ID 等）。

### 4. 确认能用

让用户点「放一段示例」，再点「整理我的想法」：十几秒后会出现整理好的中文结构和英语表达，点「确认并开始」就进入第一块的学习。第一次按 ⌘ ]（Windows 上是 Ctrl ]）开语音时，如果侧边栏没法直接要麦克风，一句会打开一个授权页，在那里允许一次就好。在别的网页上选中一段文字，右键「用一句练这段话」，也能直接开始。

### 插件版常见问题

- **"清单文件缺失"或加载失败**：选错了文件夹，要选 `dist/edge` 或解压出来、最外层有 `manifest.json` 的文件夹。
- **Anki**：Anki 要开着并装好 AnkiConnect。在「服务与 key」里勾上推送、点「保存并测试」时，浏览器会问是否允许连接本机，Anki 也会弹窗问是否允许一句，都让用户点允许；结果里的「Anki」一行显示 ✓ 就好。Anki 没有弹窗的话，在 Anki 的「工具 → 插件 → AnkiConnect → 配置」里把设置框里显示的那一行（`chrome-extension://…`）加进 `webCorsOriginList`。AnkiConnect 改过端口（`webBindPort`）的话，在设置框的「AnkiConnect 地址」里填同一个端口。
- **更新插件**：拿到新版本后覆盖原来的文件夹，在扩展页面点一句的「重新加载」。练习记录和设置保留在浏览器里，不受影响。

## 本机服务版（开发用）

一个 Node 服务（127.0.0.1:4317），页面开在浏览器标签页里。每次开机要重新 `npm start`（macOS 上也可以用 `studio/launcher.applescript` 做一个桌面启动器）。

1. `node --version` 要 ≥ 24。不需要 `npm install`。
2. `npm test` 应该全部通过；`npm start` 启动，日志里的 `Text: …`、`Voice: …`、`Speech: …` 写着用的是哪个服务商。
3. 让用户打开 http://127.0.0.1:4317 ，在弹出的「服务与 key」里填 key（这里的百炼语音不需要业务空间 ID）。也可以照 `.env.example` 写 `.env`；请用户自己粘贴 key，检查时只看变量名（`cut -d= -f1 .env`），不要输出值。

常见问题：端口被占用就在 `.env` 里改 `STUDIO_PORT`；练习记录在 `studio/data/studio.sqlite`，设置在 `studio/data/settings.json`，都不提交。
