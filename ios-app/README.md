# Mobell 博客监控 · iOS

这是 iOS 版源码（XcodeGen 工程），复用与 Windows / Android 相同的 `dist/web/app.html`，通过 WKWebView 展示，原生层提供 HTTP、GitHub API、Token（Keychain）和通知桥接。

## 构建（需要 macOS + Xcode）

```bash
# 在项目根目录
npm ci
npm run build:web
cp dist/web/app.html ios-app/Resources/app.html

brew install xcodegen
cd ios-app
xcodegen generate
open MobellMonitor.xcodeproj
```

在 Xcode 中选择自己的开发团队（个人 Apple ID 也可），连接 iPhone 运行。未配置 Token 时只显示“概览 / 设置”，保存 Token 后出现“发布”页。

## 无 Mac：GitHub Actions 生成未签名 IPA

推送到 GitHub 后，在 Actions 里手动运行 “iOS unsigned IPA”（或推送 `v*` tag），下载 `MobellMonitor-unsigned.ipa`。该 IPA 未签名，需用 Sideloadly / AltStore 等工具使用你的 Apple ID 重签后才能安装。

## 版本

- MARKETING_VERSION 1.1.0 / CURRENT_PROJECT_VERSION 2
- Bundle ID：`com.mobell.monitor`
- 最低系统：iOS 16.0
