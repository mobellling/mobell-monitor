# Mobell 博客监控 — Android 壳工程

原生 Kotlin + WebView 外壳，加载 `dist/web/app.html`（由主仓库 Web 构建产出，全部 CSS/JS 内联），并提供首页 AppWidget、JS Bridge、文件选择与通知等原生能力。

- 包名 / applicationId：`com.mobell.monitor`
- 版本：`1.2.0`（versionCode 3）
- minSdk 26，compileSdk / targetSdk 35
- 产物：`dist/android/MobellMonitor-1.2.0.apk`（已签名 release）

## 环境要求

| 组件 | 版本 / 位置 |
| --- | --- |
| JDK | 21（`C:\Program Files\Java\jdk-21.0.11`），17 亦可 |
| Android SDK | `.tools/android-sdk`（platforms;android-35、build-tools;35.0.0、platform-tools） |
| Gradle | 8.10.2（`.tools/gradle-8.10.2`） |
| AGP / Kotlin | 8.7.2 / 2.0.21 |

`local.properties` 已指向本机 SDK：

```properties
sdk.dir=D:/my-blog/mobell-monitor/.tools/android-sdk
```

## 构建

Web 资源必须先存在：`D:\my-blog\mobell-monitor\dist\web\app.html`。Gradle 任务 `copyWebApp` 会在 `preBuild` 阶段把它复制到 `app/src/main/assets/web/app.html`；文件缺失时会以明确信息失败（不会由 Android 工程自行生成页面）。

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21.0.11'
$env:ANDROID_HOME = 'D:\my-blog\mobell-monitor\.tools\android-sdk'
cd D:\my-blog\mobell-monitor

# 仅构建 release APK（输出 app/build/outputs/apk/release/app-release.apk）
& .tools\gradle-8.10.2\bin\gradle.bat -p android-app assembleRelease

# 构建并复制到 dist/android/MobellMonitor-1.2.0.apk
& .tools\gradle-8.10.2\bin\gradle.bat -p android-app distReleaseApk
```

## 签名

- Keystore：`android-app/keystore/mobell-release.jks`（alias `mobell`，RSA 2048，有效期 10000 天）。
- 密码：`android-app/keystore.properties`（不提交到外部仓库、不写入文档/日志）。格式：

```properties
storeFile=keystore/mobell-release.jks
storePassword=******
keyAlias=mobell
keyPassword=******
```

`app/build.gradle.kts` 在检测到 `keystore.properties` 时自动启用 release signingConfig；缺失时 release 构建不签名（仅用于本地调试，不用于分发）。

重新生成（示例，会覆盖旧密钥，旧 APK 将无法升级安装）：

```powershell
keytool -genkeypair -keystore android-app\keystore\mobell-release.jks -alias mobell `
  -keyalg RSA -keysize 2048 -validity 10000 -storepass <新密码> -keypass <新密码> `
  -dname "CN=Mobell Monitor, OU=Mobile, O=Mobell, L=Shanghai, ST=Shanghai, C=CN"
```

## 校验 APK

```powershell
$sdk = 'D:\my-blog\mobell-monitor\.tools\android-sdk'
& "$sdk\build-tools\35.0.0\apksigner.bat" verify --print-certs dist\android\MobellMonitor-1.2.0.apk
& "$sdk\build-tools\35.0.0\aapt2.exe" dump badging dist\android\MobellMonitor-1.2.0.apk |
  Select-String 'package:|sdkVersion:|targetSdkVersion:'
Get-FileHash dist\android\MobellMonitor-1.2.0.apk -Algorithm SHA256
```

## 结构

```
android-app/
  app/src/main/
    AndroidManifest.xml
    assets/web/app.html        # 构建时由 dist/web/app.html 复制（勿手改）
    java/com/mobell/monitor/
      MainActivity.kt          # WebView 外壳、文件选择、返回键
      MobellBridge.kt          # JS Bridge（window.MobellAndroid）
      TokenStore.kt            # Android Keystore AES/GCM 保存 GitHub Token
      Http.kt                  # 仅 HTTPS 的阻塞式 HTTP 帮助类
      WidgetWorker.kt          # WorkManager：Vercount PV/UV + 提交 atom 时间
      WidgetUpdater.kt         # RemoteViews 渲染
      MonitorWidgetProvider.kt # 4x2 可缩放桌面小组件
      WidgetState.kt           # widgetData 快照解析
    res/values|drawable|layout|xml
  keystore/mobell-release.jks
  keystore.properties
```

## JS Bridge 约定（Web 侧 `window.MobellAndroid`）

异步方法统一接收数字字符串 `id`，原生侧通过 `window.__mobellResolve(id, payloadJson)` 回调：

- 成功：`{"ok":true,"status":200,"bodyBase64":"<UTF-8 body 的 base64>"}`
- 失败（超时/网络错误）：`{"ok":false,"error":"..."}`

方法：

- `httpRequest(id, url)` — GET；仅允许 https，域名白名单：`mobellling.github.io`、`events.vercount.one`、`github.com`、`api.github.com`、`giscus.app`；超时 30 秒，最多读取 16MB
- `githubRequest(id, method, path, bodyBase64)` — 请求 `https://api.github.com + path`；GET/HEAD 为匿名请求（未保存 Token 时不带 `Authorization`），POST/PUT/PATCH/DELETE 需要 Token，缺失时返回 401 JSON `{"message":"Token 未配置"}`；GET 传输异常会自动重试一次；超时 30 秒
- 同步：`getState()/setState(json)`（应用缓存）、`getSettings()/setSettings(json)`、`hasToken()`、`setToken(token)`、`clearToken()`、`getVersion()`、`notify(title, body)`、`openExternal(url)`、`updateWidget(json)`

兼容旧回调（`__mobellHttp` / `__mobellGitHub` / `__mobellGitHubTest` / `__mobellPick`）与旧方法名（`httpText`、`gitHubRequest`、`setGitHubToken`、`clearGitHubToken`、`hasGitHubToken`、`testGitHubToken`、`pickFile`、`saveState`、`loadState`）保留，避免旧页面失效。

WebView 通过 `loadDataWithBaseURL("https://mobell.local/", html, ...)` 加载单文件页面，为 localStorage 提供稳定 https origin；未使用 `file://`。

导航限制：只有 `https://mobell.local/` 允许在 WebView 内部导航；其他 http(s) 链接交给系统浏览器打开，其他 scheme 直接拦截，避免外部页面继承已注入的 JS Bridge。

## 小组件

- 4x2 可缩放，显示站点访问 PV/UV、文章数、评论数、距上次上传；数据来自 Web 调用 `updateWidget(json)` 写入的快照（`{"sitePv":56,"siteUv":1,"posts":10,"comments":11,"lastUpload":"2026-11-03T06:31:48Z"}`），字段缺失时显示 `—`。
- 点击刷新按钮发送 `com.mobell.monitor.ACTION_REFRESH` 广播，触发 WorkManager 一次性任务；同时通过 `PeriodicWorkRequestBuilder` 每 15 分钟刷新。
- 点击小组件主体打开 App。无前台服务、无悬浮窗权限。
