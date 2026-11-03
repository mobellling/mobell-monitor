import Foundation
import UIKit
import UserNotifications
import WebKit

@MainActor
final class Bridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?

    private let tokenStore = TokenStore()
    private let allowedHosts: Set<String> = [
        "mobellling.github.io",
        "events.vercount.one",
        "github.com",
        "api.github.com",
        "giscus.app",
    ]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 45
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "mobell",
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        Task {
            let payload = await self.handle(method: method, args: args)
            self.reply(id: id, payload: payload)
        }
    }

    private func reply(id: String, payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = "window.__mobellResolve(\(jsString(id)), \(jsString(json)))"
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    private func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }

    private func handle(method: String, args: [Any]) async -> [String: Any] {
        switch method {
        case "httpRequest":
            guard let raw = args.first as? String, let url = URL(string: raw) else {
                return fail("无效的地址")
            }
            guard isAllowed(url) else { return fail("不允许的地址") }
            do {
                let (status, data) = try await request(url: url)
                return httpResult(status: status, data: data)
            } catch {
                return fail(describe(error))
            }

        case "githubRequest":
            let httpMethod = (args.first as? String) ?? "GET"
            guard args.count >= 2, let path = args[1] as? String else { return fail("无效的 GitHub 路径") }
            let bodyBase64 = args.count >= 3 ? (args[2] as? String ?? "") : ""
            return await github(method: httpMethod, path: path, bodyBase64: bodyBase64)

        case "getState":
            return ["ok": true, "value": UserDefaults.standard.string(forKey: "mobell_state") ?? "{}"]
        case "setState":
            UserDefaults.standard.set((args.first as? String) ?? "{}", forKey: "mobell_state")
            return ["ok": true]
        case "getSettings":
            return ["ok": true, "value": UserDefaults.standard.string(forKey: "mobell_settings") ?? "{}"]
        case "setSettings":
            UserDefaults.standard.set((args.first as? String) ?? "{}", forKey: "mobell_settings")
            return ["ok": true]

        case "hasToken":
            return ["ok": true, "value": tokenStore.hasToken]
        case "setToken":
            guard let token = args.first as? String, !token.isEmpty else { return fail("Token 不能为空") }
            return tokenStore.save(token) ? ["ok": true] : fail("Token 保存失败")
        case "clearToken":
            tokenStore.clear()
            return ["ok": true]

        case "notify":
            notify(
                title: (args.first as? String) ?? "Mobell 博客监控",
                body: args.count >= 2 ? (args[1] as? String ?? "") : ""
            )
            return ["ok": true]

        case "openExternal":
            if let raw = args.first as? String, let url = URL(string: raw) {
                _ = await UIApplication.shared.open(url)
            }
            return ["ok": true]

        case "updateWidget":
            return ["ok": true]

        case "getVersion":
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.1.0"
            return ["ok": true, "value": version]

        default:
            return fail("不支持的原生方法: \(method)")
        }
    }

    private func github(method: String, path: String, bodyBase64: String) async -> [String: Any] {
        let upper = method.uppercased()
        let token = tokenStore.getToken()
        let isWrite = upper != "GET" && upper != "HEAD"
        if isWrite && (token?.isEmpty ?? true) {
            let payload = Data("{\"message\":\"Token 未配置\"}".utf8)
            return httpResult(status: 401, data: payload)
        }

        let normalized = path.hasPrefix("/") ? path : "/" + path
        guard let url = URL(string: "https://api.github.com" + normalized) else {
            return fail("无效的 GitHub 地址")
        }
        var headers: [String: String] = [
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "MobellMonitor/1.1.0 (iOS)",
        ]
        if let token = token, !token.isEmpty {
            headers["Authorization"] = "Bearer \(token)"
        }
        let body = bodyBase64.isEmpty ? nil : Data(base64Encoded: bodyBase64)
        if body != nil {
            headers["Content-Type"] = "application/json"
        }
        do {
            let result: (Int, Data)
            do {
                result = try await request(url: url, method: upper, headers: headers, body: body)
            } catch {
                if upper != "GET" { throw error }
                try await Task.sleep(nanoseconds: 800_000_000)
                result = try await request(url: url, method: upper, headers: headers, body: body)
            }
            return httpResult(status: result.0, data: result.1)
        } catch {
            return fail(describe(error))
        }
    }

    private func request(
        url: URL,
        method: String = "GET",
        headers: [String: String] = [:],
        body: Data? = nil
    ) async throws -> (Int, Data) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (status, data)
    }

    private func isAllowed(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        return allowedHosts.contains(host)
    }

    private func httpResult(status: Int, data: Data) -> [String: Any] {
        [
            "ok": true,
            "status": status,
            "bodyBase64": data.base64EncodedString(),
        ]
    }

    private func fail(_ message: String) -> [String: Any] {
        ["ok": false, "error": message]
    }

    private func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut: return "请求超时（30 秒）"
            case .notConnectedToInternet: return "网络未连接"
            case .cannotFindHost, .cannotConnectToHost: return "无法连接服务器"
            default: return "网络请求失败：\(urlError.localizedDescription)"
            }
        }
        return "网络请求失败：\(error.localizedDescription)"
    }

    private func notify(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: "mobell-\(UUID().uuidString)",
                content: content,
                trigger: nil
            )
            center.add(request)
        }
    }
}
