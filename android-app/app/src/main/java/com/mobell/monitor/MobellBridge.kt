package com.mobell.monitor

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

/**
 * The `MobellAndroid` JavaScript bridge.
 *
 * Primary protocol (shared with the web app): async calls receive a numeric
 * request id and answer through `window.__mobellResolve(id, payloadJson)` where
 * the payload is either
 *   {"ok":true,"status":200,"bodyBase64":"..."}  or  {"ok":false,"error":"..."}
 *
 * Legacy callbacks (`__mobellHttp`, `__mobellGitHub`, `__mobellGitHubTest`,
 * `__mobellPick`) are kept as aliases so older web builds keep working.
 * Everything is delivered on the UI thread via [WebView.evaluateJavascript];
 * response bodies are base64-encoded UTF-8.
 */
class MobellBridge(
    private val activity: ComponentActivity,
    private val webView: WebView,
) {

    private val tokenStore = TokenStore(activity.applicationContext)
    private val executor: ExecutorService = Executors.newCachedThreadPool()

    private var pendingPickId: String? = null
    private var pendingPickKind: String? = null
    private var pendingNotification: Pair<String, String>? = null
    private var notificationPermissionRequested = false
    private var notificationId = 2000

    private val pickLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val id = pendingPickId
            pendingPickId = null
            pendingPickKind = null
            if (id == null) return@registerForActivityResult
            val uri: Uri? = result.data?.data
            if (result.resultCode != Activity.RESULT_OK || uri == null) {
                emitPick(id, "", "", "", "已取消")
                return@registerForActivityResult
            }
            executor.execute {
                try {
                    val resolver = activity.contentResolver
                    var name = uri.lastPathSegment ?: "file"
                    var size = -1L
                    runCatching {
                        resolver.query(
                            uri,
                            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                            null,
                            null,
                            null,
                        )?.use { cursor ->
                            if (cursor.moveToFirst()) {
                                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                                if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
                            }
                        }
                    }
                    if (size > MAX_FILE_BYTES) {
                        emitPick(id, name, "", "", "文件超过 5MB")
                        return@execute
                    }
                    val mime = resolver.getType(uri) ?: "application/octet-stream"
                    val bytes = resolver.openInputStream(uri)?.use { readLimited(it) }
                        ?: throw IOException("无法读取文件")
                    emitPick(id, name, mime, base64(bytes), "")
                } catch (t: Throwable) {
                    emitPick(id, "file", "", "", t.message ?: "读取文件失败")
                }
            }
        }

    private val notificationPermissionLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val pending = pendingNotification
            pendingNotification = null
            if (granted && pending != null) postNotification(pending.first, pending.second)
        }

    // ------------------------------------------------------- new HTTP API

    @JavascriptInterface
    fun httpRequest(id: String, url: String) {
        val rejected = rejectUrl(url)
        if (rejected != null) {
            emitResolveError(id, rejected)
            return
        }
        executor.execute {
            try {
                val response = Http.request(url.trim(), maxBytes = 16 * 1024 * 1024)
                emitResolve(id, response.status, response.bytes)
            } catch (t: Throwable) {
                emitResolveError(id, describeError(t, "网络请求失败"))
            }
        }
    }

    @JavascriptInterface
    fun githubRequest(id: String, method: String, path: String, bodyBase64: String) {
        executor.execute { performGithub(id, method, path, bodyBase64, resolveStyle = true) }
    }

    // ------------------------------------------------------- legacy HTTP API

    @JavascriptInterface
    fun httpText(id: String, url: String) {
        executor.execute {
            try {
                val response = Http.request(url, maxBytes = 16 * 1024 * 1024)
                emit("__mobellHttp", id, response.status, base64(response.bytes), "")
            } catch (t: Throwable) {
                emit("__mobellHttp", id, 0, "", describeError(t, "网络请求失败"))
            }
        }
    }

    @JavascriptInterface
    fun gitHubRequest(id: String, method: String, path: String, bodyBase64: String) {
        executor.execute { performGithub(id, method, path, bodyBase64, resolveStyle = false) }
    }

    private fun performGithub(id: String, method: String, path: String, bodyBase64: String, resolveStyle: Boolean) {
        val token = tokenStore.getToken()
        val upper = method.trim().uppercase(Locale.ROOT)
        if (upper !in ALLOWED_METHODS) {
            val message = "不支持的请求方法: $method"
            if (resolveStyle) emitResolveError(id, message) else emit("__mobellGitHub", id, 0, "", message)
            return
        }
        val needsToken = upper != "GET" && upper != "HEAD"
        if (needsToken && token.isNullOrEmpty()) {
            if (resolveStyle) {
                emitResolve(id, 401, TOKEN_MISSING_JSON.toByteArray(Charsets.UTF_8))
            } else {
                emit("__mobellGitHub", id, 401, base64(TOKEN_MISSING_JSON.toByteArray(Charsets.UTF_8)), "")
            }
            return
        }
        try {
            val body = if (bodyBase64.isBlank()) null else Base64.decode(bodyBase64, Base64.DEFAULT)
            val headers = linkedMapOf(
                "Accept" to "application/vnd.github+json",
                "X-GitHub-Api-Version" to "2022-11-28",
                "User-Agent" to USER_AGENT,
            )
            if (!token.isNullOrEmpty()) headers["Authorization"] = "Bearer $token"
            if (body != null) headers["Content-Type"] = "application/json"
            val normalizedPath = if (path.startsWith("/")) path else "/$path"
            val url = "https://api.github.com$normalizedPath"
            fun send(): Http.Response = Http.request(
                url = url,
                method = upper,
                headers = headers,
                body = body,
            )
            val response = try {
                send()
            } catch (t: Throwable) {
                if (upper != "GET") throw t
                Thread.sleep(800)
                send()
            }
            if (resolveStyle) {
                emitResolve(id, response.status, response.bytes)
            } else {
                emit("__mobellGitHub", id, response.status, base64(response.bytes), "")
            }
        } catch (t: Throwable) {
            val message = describeError(t, "GitHub 请求失败")
            if (resolveStyle) emitResolveError(id, message) else emit("__mobellGitHub", id, 0, "", message)
        }
    }

    // ----------------------------------------------------------------- token

    @JavascriptInterface
    fun setGitHubToken(token: String): String {
        return try {
            if (token.isBlank()) {
                """{"ok":false,"message":"Token 为空"}"""
            } else {
                tokenStore.saveToken(token.trim())
                """{"ok":true}"""
            }
        } catch (t: Throwable) {
            Log.w(TAG, "setGitHubToken failed", t)
            """{"ok":false,"message":${JSONObject.quote(t.message ?: "保存 Token 失败")}}"""
        }
    }

    @JavascriptInterface
    fun clearGitHubToken() {
        tokenStore.clear()
    }

    @JavascriptInterface
    fun hasGitHubToken(): Boolean = tokenStore.hasToken()

    @JavascriptInterface
    fun setToken(token: String) {
        if (token.isBlank()) return
        runCatching { tokenStore.saveToken(token.trim()) }
            .onFailure { Log.w(TAG, "setToken failed", it) }
    }

    @JavascriptInterface
    fun clearToken() {
        tokenStore.clear()
    }

    @JavascriptInterface
    fun hasToken(): Boolean = tokenStore.hasToken()

    @JavascriptInterface
    fun testGitHubToken(id: String) {
        executor.execute {
            val token = tokenStore.getToken()
            if (token.isNullOrEmpty()) {
                emitTest(id, 401, testBody(false, "", false, false, "Token 未配置"))
                return@execute
            }
            try {
                val repo = githubGet(token, REPO_PATH)
                val user = githubGet(token, "/user")
                val ref = githubGet(token, "/git/ref/heads/master")

                var login = ""
                if (user.status in 200..299) {
                    login = runCatching {
                        JSONObject(user.bodyText()).optString("login", "")
                    }.getOrDefault("")
                }

                var push = false
                val messages = mutableListOf<String>()
                var repoAccessible = false
                when {
                    repo.status in 200..299 -> {
                        repoAccessible = true
                        push = runCatching {
                            JSONObject(repo.bodyText()).optJSONObject("permissions")
                                ?.optBoolean("push", false) ?: false
                        }.getOrDefault(false)
                        messages += if (push) {
                            "仓库可访问，推送权限已授予"
                        } else {
                            "仓库可访问，但当前 Token 没有推送权限（只读）"
                        }
                    }
                    repo.status == 401 -> messages += "Token 无效或已过期（HTTP 401）"
                    repo.status == 403 -> messages += "Token 权限不足（HTTP 403）"
                    repo.status == 404 -> messages += "仓库不存在或无权访问（可能缺少 repo 权限）"
                    else -> messages += "仓库请求失败（HTTP ${repo.status}）"
                }
                if (login.isNotEmpty()) messages += "登录用户：$login"
                if (ref.status in 200..299) {
                    messages += "master 分支正常"
                } else if (repoAccessible) {
                    messages += "未找到 master 分支（HTTP ${ref.status}）"
                }

                val ok = repoAccessible && login.isNotEmpty()
                val status = when {
                    ok -> 200
                    repo.status in 400..599 -> repo.status
                    else -> 200
                }
                emitTest(id, status, testBody(ok, login, repoAccessible, push, messages.joinToString("；")))
            } catch (t: Throwable) {
                emitTest(id, 0, testBody(false, "", false, false, "网络错误：${t.message ?: "请求失败"}"))
            }
        }
    }

    // --------------------------------------------------------------- picker

    @JavascriptInterface
    fun pickFile(id: String, kind: String) {
        activity.runOnUiThread {
            if (pendingPickId != null) {
                emitPick(id, "", "", "", "已有文件选择正在进行")
                return@runOnUiThread
            }
            pendingPickId = id
            pendingPickKind = kind
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                if (kind.equals("image", ignoreCase = true)) {
                    type = "image/*"
                } else {
                    type = "text/*"
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf("text/*", "text/markdown", "text/x-markdown", "application/octet-stream"),
                    )
                }
            }
            try {
                pickLauncher.launch(intent)
            } catch (t: Throwable) {
                pendingPickId = null
                pendingPickKind = null
                emitPick(id, "", "", "", "无法打开文件选择器")
            }
        }
    }

    // ---------------------------------------------------------------- state

    @JavascriptInterface
    fun getState(): String =
        prefs().getString(KEY_APP_STATE, "") ?: ""

    @JavascriptInterface
    fun setState(json: String) {
        prefs().edit().putString(KEY_APP_STATE, json).apply()
    }

    @JavascriptInterface
    fun getSettings(): String =
        prefs().getString(KEY_SETTINGS, "") ?: ""

    @JavascriptInterface
    fun setSettings(json: String) {
        prefs().edit().putString(KEY_SETTINGS, json).apply()
    }

    @JavascriptInterface
    fun saveState(json: String) = setState(json)

    @JavascriptInterface
    fun loadState(): String = getState()

    @JavascriptInterface
    fun updateWidget(json: String) {
        WidgetState.saveRaw(activity.applicationContext, json)
        WidgetUpdater.updateAll(activity.applicationContext)
    }

    // -------------------------------------------------------------- external

    @JavascriptInterface
    fun openExternal(url: String) {
        val uri = runCatching { Uri.parse(url.trim()) }.getOrNull() ?: return
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "https" && scheme != "http") return
        activity.runOnUiThread {
            runCatching {
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }.onFailure { Log.w(TAG, "openExternal failed", it) }
        }
    }

    // --------------------------------------------------------- notification

    @JavascriptInterface
    fun notify(title: String, body: String) {
        val context = activity.applicationContext
        val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        if (needsPermission) {
            activity.runOnUiThread {
                pendingNotification = title to body
                if (!notificationPermissionRequested) {
                    notificationPermissionRequested = true
                    runCatching {
                        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
            }
            return
        }
        postNotification(title, body)
    }

    @JavascriptInterface
    fun getVersion(): String = BuildConfig.VERSION_NAME

    fun detach() {
        executor.shutdownNow()
        pendingPickId = null
        pendingPickKind = null
        pendingNotification = null
    }

    // -------------------------------------------------------------- helpers

    private fun prefs() = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Returns a rejection message, or null when [url] is an allowed HTTPS request. */
    private fun rejectUrl(url: String): String? {
        val uri = runCatching { Uri.parse(url.trim()) }.getOrNull() ?: return "无效的 URL"
        if (!uri.scheme.equals("https", ignoreCase = true)) return "仅允许 https 请求"
        val host = uri.host?.lowercase(Locale.ROOT) ?: return "无效的域名"
        return if (host in ALLOWED_HOSTS) null else "域名不在允许列表：$host"
    }

    private fun githubGet(token: String, path: String): Http.Response = Http.request(
        url = "https://api.github.com$path",
        method = "GET",
        headers = mapOf(
            "Authorization" to "Bearer $token",
            "Accept" to "application/vnd.github+json",
            "X-GitHub-Api-Version" to "2022-11-28",
            "User-Agent" to USER_AGENT,
        ),
    )

    private fun Http.Response.bodyText(): String = bytes.toString(Charsets.UTF_8)

    private fun emitResolve(id: String, status: Int, bytes: ByteArray) {
        val payload = JSONObject().apply {
            put("ok", true)
            put("status", status)
            put("bodyBase64", base64(bytes))
        }
        postScript(
            "window.__mobellResolve && window.__mobellResolve(" +
                "${JSONObject.quote(id)}, ${JSONObject.quote(payload.toString())});",
        )
    }

    private fun emitResolveError(id: String, message: String) {
        val payload = JSONObject().apply {
            put("ok", false)
            put("error", message)
        }
        postScript(
            "window.__mobellResolve && window.__mobellResolve(" +
                "${JSONObject.quote(id)}, ${JSONObject.quote(payload.toString())});",
        )
    }

    private fun emit(function: String, id: String, status: Int, bodyBase64: String, error: String) {
        val script = "window.$function && window.$function(" +
            "${JSONObject.quote(id)}, $status, " +
            "${JSONObject.quote(bodyBase64)}, ${JSONObject.quote(error)});"
        postScript(script)
    }

    private fun emitPick(id: String, name: String, mime: String, bodyBase64: String, error: String) {
        val script = "window.__mobellPick && window.__mobellPick(" +
            "${JSONObject.quote(id)}, ${JSONObject.quote(name)}, ${JSONObject.quote(mime)}, " +
            "${JSONObject.quote(bodyBase64)}, ${JSONObject.quote(error)});"
        postScript(script)
    }

    private fun emitTest(id: String, status: Int, bodyJson: String) {
        emit("__mobellGitHubTest", id, status, base64(bodyJson.toByteArray(Charsets.UTF_8)), "")
    }

    private fun postScript(script: String) {
        webView.post {
            runCatching { webView.evaluateJavascript(script, null) }
        }
    }

    private fun describeError(t: Throwable, fallback: String): String = when (t) {
        is SocketTimeoutException -> "请求超时（20 秒）"
        is UnknownHostException -> "无法解析域名"
        is ConnectException -> "网络连接失败"
        is SSLException -> "TLS 连接失败：${t.message ?: "证书错误"}"
        else -> t.message ?: fallback
    }

    private fun testBody(
        ok: Boolean,
        login: String,
        repo: Boolean,
        push: Boolean,
        message: String,
    ): String {
        val json = JSONObject()
        json.put("ok", ok)
        json.put("login", login)
        json.put("repo", repo)
        json.put("push", push)
        json.put("message", message)
        return json.toString()
    }

    private fun postNotification(title: String, body: String) {
        try {
            val context = activity.applicationContext
            createNotificationChannel(context)
            val contentIntent = PendingIntent.getActivity(
                context,
                2002,
                Intent(context, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title.ifBlank { "Mobell 博客监控" })
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
            NotificationManagerCompat.from(context).notify(notificationId++, notification)
        } catch (t: Throwable) {
            Log.w(TAG, "notify failed", t)
        }
    }

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Mobell 通知", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
    }

    private fun readLimited(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            total += read
            if (total > MAX_FILE_BYTES) throw IOException("文件超过 5MB")
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    private fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private companion object {
        const val TAG = "MobellBridge"
        const val USER_AGENT = "MobellMonitor/1.0.0"
        const val CHANNEL_ID = "mobell"
        const val MAX_FILE_BYTES = 5 * 1024 * 1024
        const val REPO_PATH = "/repos/mobellling/mobellling.github.io"
        const val TOKEN_MISSING_JSON = """{"message":"Token 未配置"}"""
        const val PREFS_NAME = "mobell"
        const val KEY_APP_STATE = "app_state"
        const val KEY_SETTINGS = "settings"
        val ALLOWED_METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE")
        val ALLOWED_HOSTS = setOf(
            "mobellling.github.io",
            "events.vercount.one",
            "github.com",
            "api.github.com",
            "giscus.app",
        )
    }
}
