import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.isFile) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

android {
    namespace = "com.mobell.monitor"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mobell.monitor"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
    }

    if (keystorePropertiesFile.isFile) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (keystorePropertiesFile.isFile) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}

// ---------------------------------------------------------------------------
// Bundle the self-contained web application produced by the Lead.
// Fails with a clear message when dist/web/app.html does not exist yet.
// ---------------------------------------------------------------------------
val webAppSource: File = rootProject.file("../dist/web/app.html")
val webAssetFile: File = layout.projectDirectory.file("src/main/assets/web/app.html").asFile

val copyWebApp = tasks.register("copyWebApp") {
    group = "build"
    description = "Copy dist/web/app.html into app assets/web/app.html."

    inputs.file(webAppSource).withPropertyName("webApp").optional()
    outputs.file(webAssetFile)

    doLast {
        if (!webAppSource.isFile) {
            throw GradleException(
                "Missing web application: ${webAppSource.absolutePath}. " +
                    "The Lead must build dist/web/app.html before the Android APK can be assembled.",
            )
        }
        webAssetFile.parentFile.mkdirs()
        webAppSource.copyTo(webAssetFile, overwrite = true)
        logger.lifecycle("Bundled web app (${webAppFileLength()} bytes) -> assets/web/app.html")
    }
}

fun webAppFileLength(): Long = if (webAppSource.isFile) webAppSource.length() else 0L

tasks.named("preBuild") {
    dependsOn(copyWebApp)
}

// Copy the signed release APK to the shared dist/android directory, named
// after the configured versionName (e.g. MobellMonitor-1.1.0.apk).
val releaseVersionName: String = android.defaultConfig.versionName ?: "1.0.0"
val distReleaseApk = tasks.register<Copy>("distReleaseApk") {
    group = "build"
    description = "Copy the signed release APK to dist/android/MobellMonitor-$releaseVersionName.apk."
    dependsOn("assembleRelease")
    from(layout.buildDirectory.file("outputs/apk/release/app-release.apk"))
    into(rootProject.file("../dist/android"))
    rename { "MobellMonitor-$releaseVersionName.apk" }
}
