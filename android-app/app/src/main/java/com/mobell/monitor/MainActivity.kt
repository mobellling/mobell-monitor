package com.mobell.monitor

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

/**
 * Single-activity WebView shell. The self-contained web app is loaded from
 * assets and served through [WebView.loadDataWithBaseURL] with an https base
 * URL, which gives localStorage a stable secure origin (no file:// usage).
 */
class MainActivity : ComponentActivity() {

    private var webView: WebView? = null
    private var bridge: MobellBridge? = null

    // Strong reference kept for the lifetime of the activity (loadDataWithBaseURL
    // does not copy the string; dropping it can leave the page with a detached
    // backing buffer on some WebView versions).
    private var html: String? = null

    // The publish tab uses <input type="file"> for cover images and .md imports.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = fileChooserCallback
            fileChooserCallback = null
            if (callback == null) return@registerForActivityResult
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            callback.onReceiveValue(uris)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this).apply { setBackgroundColor(BACKGROUND) }
        val wv = WebView(this).apply { setBackgroundColor(BACKGROUND) }
        webView = wv
        root.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        // targetSdk 35 enforces edge-to-edge; pad the WebView clear of system bars.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = userAgentString + " MobellMonitor/1.0.0"
        }
        // Only the bundled app page may live inside this WebView: the JS bridge
        // stays attached to the WebView, so an external page must never replace
        // the app page. External links go to the system browser instead.
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url
                val scheme = url.scheme?.lowercase(Locale.ROOT)
                if (scheme == "https" && url.host == "mobell.local") return false
                if (scheme == "http" || scheme == "https") {
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                }
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                chromeWebView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                return try {
                    val intent = fileChooserParams.createIntent().apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                    }
                    fileChooserLauncher.launch(intent)
                    true
                } catch (t: Throwable) {
                    fileChooserCallback = null
                    false
                }
            }
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val view = webView
                    if (view != null && view.canGoBack()) {
                        view.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )

        val content = readWebAsset()
        if (content == null) {
            wv.loadDataWithBaseURL(BASE_URL, errorPage(), "text/html", "UTF-8", null)
            return
        }
        html = content
        val jsBridge = MobellBridge(this, wv)
        bridge = jsBridge
        wv.addJavascriptInterface(jsBridge, "MobellAndroid")
        wv.loadDataWithBaseURL(BASE_URL, content, "text/html", "UTF-8", null)
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        webView?.let { wv ->
            bridge?.detach()
            runCatching { wv.removeJavascriptInterface("MobellAndroid") }
            runCatching { wv.loadUrl("about:blank") }
            runCatching { wv.destroy() }
        }
        webView = null
        bridge = null
        html = null
        super.onDestroy()
    }

    private fun readWebAsset(): String? = runCatching {
        assets.open("web/app.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
    }.getOrNull()

    private fun errorPage(): String = """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <style>
            body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
              background:#0F1115;color:#F2F5F9;font-family:system-ui,-apple-system,sans-serif;
              text-align:center;padding:24px}
            h1{font-size:18px;margin:0 0 8px}
            p{color:#9AA5B8;font-size:13px;margin:0;line-height:1.6}
          </style>
        </head>
        <body>
          <div>
            <h1>页面资源缺失</h1>
            <p>APK 中未找到 assets/web/app.html，请重新构建应用。</p>
          </div>
        </body>
        </html>
    """.trimIndent()

    private companion object {
        const val BASE_URL = "https://mobell.local/"
        val BACKGROUND: Int = Color.parseColor("#0F1115")
    }
}
