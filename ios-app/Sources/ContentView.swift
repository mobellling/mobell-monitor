import SwiftUI
import WebKit

struct ContentView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true

        let bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "mobell")
        configuration.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        bridge.webView = webView
        context.coordinator.bridge = bridge

        let bundled = Bundle.main.url(forResource: "app", withExtension: "html")
            ?? Bundle.main.url(forResource: "app", withExtension: "html", subdirectory: "Resources")
        if let url = bundled {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator {
        var bridge: Bridge?
    }
}
