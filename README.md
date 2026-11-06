# Mobell 博客监控

一个不依赖 DeepSeek Harness 的独立应用，用来实时查看 [mobellling.github.io](https://mobellling.github.io) 的数据，并可以直接把 Markdown 文章和日常动态发布到博客的 GitHub 仓库。支持 Windows、Android，以及 iOS（源码 + 未签名 IPA 构建流程）。

## 下载与构建产物

Windows / Android 安装包构建后位于 `dist/`，发布时上传到 GitHub Releases；iOS 为源码交付，不在 Windows 上生成二进制：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `dist/windows/MobellMonitor-1.3.1-win64.zip` | 解压后运行 `MobellMonitor.exe`，免安装 |
| Android | `dist/android/MobellMonitor-1.3.1.apk` | 直接安装，minSdk 26（Android 8.0+） |
| iOS | `ios-app/` + `.github/workflows/ios-unsigned.yml` | XcodeGen 工程；在 macOS 构建并重签后安装 |

Windows 版是 Electron 应用；安卓版是原生 Kotlin WebView 应用，主屏幕带 4×2 数据小组件；iOS 版是 WKWebView 外壳，复用同一份 `dist/web/app.html`，Token 存在 Keychain。

## 功能

- **概览**：站点总访问量 / 独立访客、文章数、评论数、总字数、距上次上传时间、最近一次提交；文章表格支持按阅读、评论、字数、发布时间排序。
- **发布**：在应用内写 Markdown 并通过 GitHub API 直接提交到 `src/data/post`，支持导入 `.md`、封面图片（自动转为 WebP）、标签、分类、草稿、URL slug 预览；提交后自动轮询 RSS 等待部署完成（最多 10 分钟）。**安卓 / iOS 未保存 Token 时不显示发布页**。
- **动态**：发布类似 QQ 动态的短内容到博客 `/moments/`，支持最多 6 张图片、自定义时间；图片会自动转为 WebP（超过 1.5MB 时同时压缩尺寸）。**所有平台都需要先保存 Token 才显示动态页**，提交后轮询动态详情页直到部署完成。
- **设置**：GitHub Token 管理、刷新间隔、桌面置顶 / 悬浮窗（Windows）、通知、检查更新。
- **检查更新**：三个平台启动后自动检查 GitHub Releases，发现新版本弹窗提示更新内容；也可在“设置 → 版本与更新”手动检查，可对某个版本选择“稍后提醒”。
- **桌面悬浮窗（Windows）**：无边框、半透明、置顶小窗，可拖动，显示 PV/UV、文章、评论、字数、距上次上传；托盘可随时开关。
- **安卓小组件**：4×2 RemoteViews，显示 PV/UV、文章数、评论数、距上次上传；手动刷新 + WorkManager 最少 15 分钟自动刷新。

## 数据来源

| 指标 | 来源 | 刷新频率 |
| --- | --- | --- |
| 站点 PV / UV | Vercount `GET https://events.vercount.one/api/v2/log?url=<完整页面地址>` | 90 秒 |
| 每篇阅读量 | 同上，逐篇请求 | 90 秒 |
| 文章列表 / 标题 / 日期 | `/blog/` 与 `/blog/2/`（失败时回退 RSS） | 10 分钟 |
| 每篇字数 | 抓取文章页面正文，统计 CJK 字符 + 拉丁词 | 24 小时（有新提交时失效） |
| 评论数 | GitHub Discussions REST API → 失败回退 `github.com/.../discussions` 页面 → 失败保留上次数据 | 10 分钟 |
| 最近上传 | GitHub Commits API → 失败回退 RSS `lastBuildDate` | 10 分钟 |
| 新版本 | `https://api.github.com/repos/<更新仓库>/releases/latest` | 启动时 + 每 6 小时 |

说明：

- 应用只读取 Vercount，不会增加阅读量（Vercount 只有 POST 才会写）。
- 评论数对应 giscus 使用的 Discussions 标题（即文章路径），5 条现有讨论共 11 条评论。
- 字数统计是近似值：中文按字、英文按词，文章页中的代码块/导航也会被计入一部分。
- 数据源状态分开显示（访问量 / 文章与字数 / 评论）；单一来源失败不会把其他指标标成异常。

## Windows 使用

1. 解压 zip 到任意目录（不要只把 exe 拖出来，需要 `resources` 等文件）。
2. 双击 `MobellMonitor.exe`。首次运行 Windows SmartScreen 可能提示“未知发布者”，选择“更多信息 → 仍要运行”。
3. 关闭主窗口会缩到托盘，不会退出；托盘菜单可打开主界面、开关悬浮窗或退出。
4. 悬浮窗默认不自动开启，可在“设置 → 桌面”或点击主界面右上角“悬浮窗”。

### 发布文章前配置 Token

1. 打开 GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token。
2. Repository access 选择 `mobellling/mobellling.github.io`。
3. Permissions → Repository permissions → **Contents: Read and write**（Metadata 会自动只读）。
4. 复制 token，在应用“设置”中粘贴保存。Token 只保存在本机：Windows 使用系统 DPAPI（Electron `safeStorage`）加密后写入 `%APPDATA%\mobell-monitor\mobell-monitor.json`；安卓使用 Android Keystore；iOS 使用 Keychain。界面和日志不会回显 token。

保存后可以直接点“校验”，再回“发布”页提交。没有 token 时应用会给出明确提示，不会尝试发布。

## 安卓使用

1. 安装 `MobellMonitor-1.3.1.apk`（首次需允许“安装未知来源应用”）。
2. 打开应用，首次同步约 10–20 秒。
3. 添加小组件：长按桌面 → 小组件 → 找到“Mobell 博客监控” → 拖到桌面；点小组件刷新按钮可立即更新。
4. 未保存 Token 时只显示“概览 / 设置”；在“设置”里保存 Token 后才会出现“发布 / 动态”页。
5. 安卓端通过 `@JavascriptInterface` 桥接原生 HTTP，网页本身不直接访问网络。

## iOS 使用

本机是 Windows，无法直接编译 iOS IPA，因此仓库提供完整工程和自动构建流程：

1. **有 Mac**：安装 XcodeGen（`brew install xcodegen`），在项目根目录执行 `npm run build:web`，复制 `dist/web/app.html` 到 `ios-app/Resources/app.html`，然后：
   ```bash
   cd ios-app && xcodegen generate
   open MobellMonitor.xcodeproj
   ```
   用 Xcode 选择自己的开发团队（个人 Apple ID 也可），连接 iPhone 运行即可。
2. **没有 Mac**：在 GitHub Actions 手动运行 “iOS unsigned IPA”（或推送 `v*` 标签自动触发），下载 `MobellMonitor-unsigned.ipa`。
3. **用 Sideloadly 安装未签名 IPA**（Windows 可用）：
   1. 先安装 Apple 官方的 iTunes 或 iCloud（Sideloadly 需要其中的驱动）；
   2. iPhone 连接电脑、解锁并点“信任此电脑”；
   3. 打开 Sideloadly，把 IPA 拖进窗口，输入你的 Apple ID；
   4. 按提示完成双重认证，点 Start，等待签名和安装完成；
   5. 手机上打开“设置 → 通用 → VPN 与设备管理”，信任你的开发者证书；
   6. 免费 Apple ID 签名的应用 **7 天后过期**，每周重新拖一次 IPA 重签即可；付费开发者证书可一年。
4. 未保存 Token 时同样不显示发布 / 动态页；Token 存入 Keychain。

## 发布更新（三个平台）

更新检查读取 `core/config.js` 中的 `DEFAULTS.updates.repo`，默认是 `mobellling/mobell-monitor`。你需要：

1. 在 GitHub 新建仓库 `mobellling/mobell-monitor`，把本项目推送上去。
2. 修改版本号（三处保持一致）：
   - `package.json` 的 `version`
   - `core/config.js` 的 `VERSION`
   - `android-app/app/build.gradle.kts` 的 `versionCode` / `versionName`
   - iOS 的 `ios-app/project.yml` 中 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`
3. 重新构建：
   ```powershell
   npm test
   npm run build:web
   npm run pack:win
   .\android-app\gradlew.bat -p android-app distReleaseApk
   ```
4. 在 GitHub 创建 Release，tag 用 `v1.3.1` 这种格式，并上传：
   - `dist/windows/MobellMonitor-1.3.1-win64.zip`
   - `dist/android/MobellMonitor-1.3.1.apk`
   - （可选）iOS 的未签名 IPA
5. 也可以直接用脚本发布（需要能创建 Release 的 `GITHUB_TOKEN`）：
   ```powershell
   $env:GITHUB_TOKEN = "ghp_xxx"
   powershell -ExecutionPolicy Bypass -File scripts\push-release.ps1 -Version 1.3.1
   ```
   脚本会自动创建/更新 `v1.3.1` Release 并上传已构建的安装包。应用启动时或点击“检查更新”即可看到弹窗。

> 注意：更新弹窗只负责提示和打开发布页/安装包下载地址，不会静默覆盖安装；Windows 解压替换、Android 覆盖安装、iOS 需要用 Mac 或重签工具重新安装。

## 从源码构建

需要 Node.js 20+（开发时使用 24.22.1）。Windows 打包不需要 Visual Studio。

```powershell
git clone https://github.com/mobellling/mobell-monitor.git
cd mobell-monitor
npm install
npm test
npm run build:web      # 生成 dist/web/app.html（单文件，含 CSS/JS）
npm run icon           # 生成 build/icon.png 与 build/icon.ico
npm run pack:win       # 生成 dist/windows/MobellMonitor-1.3.1-win64.zip
```

安卓构建需要 JDK 21、Android SDK platform 35 / build-tools 35。先安装 SDK，并用环境变量 `ANDROID_HOME` 或 `android-app/local.properties` 中的 `sdk.dir` 指向它。仓库**不包含**签名证书，需要在本机生成一份：

```powershell
keytool -genkeypair -v -keystore android-app\keystore\mobell-release.jks -alias mobell -keyalg RSA -keysize 2048 -validity 10000
```

然后在 `android-app\keystore.properties` 写入：

```properties
storeFile=keystore/mobell-release.jks
storePassword=你的密码
keyAlias=mobell
keyPassword=你的密码
```

构建 APK（首次会自动下载 Gradle 8.10.2；如果默认 JDK 不是 21，先设置 `JAVA_HOME`）：

```powershell
.\android-app\gradlew.bat -p android-app distReleaseApk
```

更换网页后必须重新构建 APK，因为 `app.html` 是打包进 APK 的静态资源；`dist/`、`.tools/`、证书与密码均已被 `.gitignore` 排除。

iOS 的 XcodeGen 工程在 `ios-app/`，构建步骤见上；`.github/workflows/ios-unsigned.yml` 可在 macOS runner 上生成未签名 IPA。

## 目录结构

```
core/       共享 JS 核心：解析、数据源、文章/动态发布、Markdown、更新检查（浏览器/Node 通用）
web/        单页界面与平台适配层（Windows IPC / Android / iOS bridge / 浏览器演示）
desktop/    Electron 主进程、preload、托盘与悬浮窗
ios-app/    XcodeGen Swift 工程（WKWebView + Keychain + 原生 HTTP 桥）
scripts/    build-web.js / gen-icon.js / pack-win.js / push-release.ps1
test/       node:test 单元测试 + 真实页面 fixtures
android-app Kotlin WebView 应用、桥接、Widget、签名配置
.github/    iOS 未签名 IPA 构建工作流
dist/       构建产物（web / windows / android）
```

## 已知限制

- GitHub 匿名 REST API 限额为每小时 60 次（按出口 IP 共享）。应用已做 HTML 回退和缓存，但最稳妥的方式仍是配置 Token；配置后限额为 5000 次/小时。
- 本机到 `github.com` 的网页请求偶发超时，评论/提交时间会自动回退到 API、RSS 或上次缓存，界面会标注“部分异常”而不是清空数据。
- 安卓版因本机没有 adb / 模拟器，只做了静态验证（`apksigner verify`、`aapt2`、APK 内容比对）与界面截图检查，未在真机上做完整运行时测试；如遇 WebView 或小组件问题请反馈。
- iOS 版需要 macOS/Xcode 才能编译安装；Windows 上只能生成工程源码，未签名 IPA 必须重签。
- APK 只使用 v2 签名，适用于 Android 8.0+。
- 字数与阅读量均为第三方公开数据的近似统计，可能因页面改版而需要调整解析规则。

## 测试

```powershell
npm test
```

41 个测试覆盖：博客列表/文章/ RSS / Vercount / Discussions 解析、slug 规则、文章与动态 frontmatter / 图片路径、Git Data API 原子提交、冲突重试、评论 API→HTML 回退、提交时间 RSS 回退、版本比较与更新检查。
