# no obfuscation is enabled; keep the JS bridge reachable by name
-keep class com.mobell.monitor.MobellBridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
