# 课程采集与复习系统

一个运行在 Windows 与 DeepSeek Harness 中的自学工具。它按实际播放范围准备字幕或本地转写，先提炼主线再出题，保存作答与到期复习。知识树用可核对的来源表示概念关系，可按节点补查一层直接前置。

## 环境

- Node.js 24 或以上，含 npm。
- Edge 或 Chrome。完整采集流程需要 Windows、DeepSeek Harness 和可用的模型账户。
- 安装依赖后可以在隔离环境验证答题、到期复习和程序测试。该环境使用固定题和模拟作答。

## 打开免账户演示

克隆仓库后，在仓库根目录打开 PowerShell。

```powershell
node -v
npm ci
node run-demo.mjs
```

1. 把终端打印的 `http://127.0.0.1:<端口>` 地址粘贴到浏览器。
2. 在“学习”选试用 P2 课程查看固定题，或点“开始 / 继续到期复习”。提交一个客观题，核对反馈、作答历史与经验。
3. 用页面刷新验证作答仍在。按 Ctrl+C 结束演示。再次执行启动命令会建立一份新的演示库。

演示使用原程序的面板、HTTP 服务、题卡处理和数据库。实时采集、出题和模型判卷需要下节的完整环境。演示保存的记录位于本目录 `.probe`。

## 在 DeepSeek Harness 中运行完整系统

1. 初始化试用库。在仓库根目录执行 `node test/prepare-m2-demo.mjs`。若修改过前端源码，执行 `npm run build:panel`。
2. 退出 DSH。在其桌面 profile 的 `package.json` 中，将本地 `plugin` 目录作为 `dsh-study-panel` 的文件链接依赖，并在已有的 `dsh.profile.bundles` 数组添加 `dsh-study-panel`。保留其他配置。该插件的 `cordis.patch.yml` 注册面板及独立执行器。
3. 确认该 profile 的 `node_modules/dsh-study-panel` 指向仓库内的 `plugin` 目录。Windows 本地可在链接尚不存在时用下面的命令建立目录联接。

```powershell
$studyPlugin = (Resolve-Path .\plugin).Path
$studyPluginDeps = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules'
New-Item -ItemType Directory -Path $studyPluginDeps -Force | Out-Null
New-Item -ItemType Junction -Path (Join-Path $studyPluginDeps 'dsh-study-panel') -Target $studyPlugin
```

4. 启动 DSH，打开学习面板，切换“使用试用数据”。如果本机服务未就绪，在仓库根目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Study-AtLogon.ps1`。服务仅监听回环地址。正式库使用 7788，试用库使用 7789。
5. 网页采集在 Edge 或 Chrome 加载 `browser-extension` 目录并在扩展页按提示配对。使用试用库时用试用库的配对码。支持的 Windows B 站客户端可从总览发起识别。客户端为采集进度而重开后，可能需要重新进入课程。
6. 在总览开始采集，播放至少 30 秒的有效内容，结束后等待材料准备。出现“出题”后生成题目，在学习页作答，或在知识树查看课程邻域。主观题的反馈和补答在学习页。

本地音频识别是可选能力，准备脚本为 `Setup-Audio.ps1`。脚本需要下载固定版本模型与原生采集依赖。重新构建音频采集组件需要 Visual Studio C++ 工具、Windows SDK 和 CMake。课堂答题演示和程序回归无需安装语音模型。

## 运行验证

```powershell
npm test
```

测试入口是 `test/all.mjs`。报告所列自动验证覆盖采集范围、题卡校验、重复提交、追问轮次、暂不出题和知识图合并。测试使用临时库，外部模型响应使用固定替身。仓库使用 `fixtures/` 中的自编材料和固定题。课程实践报告中记录的实际观看、出题和作答保存在原验收环境。

## 目录

| 路径 | 用途 |
| --- | --- |
| `server/` | 本地服务、存储、采集和复习 |
| `plugin/` | 学习面板、模型执行及知识导航 |
| `browser-extension/` | 浏览器采集桥 |
| `test/` | 隔离回归和固定题演示 |
| `fixtures/` | 带来源的测试材料 |
