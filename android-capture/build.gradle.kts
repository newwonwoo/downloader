import java.util.Base64

plugins {
    id("com.android.application")
}

val buildSha = (System.getenv("GITHUB_SHA") ?: "local").take(8)
val devKeystoreSource = file("dev-signing-keystore.b64")
val devKeystoreFile = layout.buildDirectory.file("signing/video-save-dev.jks").get().asFile

if (devKeystoreSource.isFile) {
    devKeystoreFile.parentFile.mkdirs()
    devKeystoreFile.writeBytes(Base64.getMimeDecoder().decode(devKeystoreSource.readText()))
}

android {
    namespace = "com.newwonwoo.downloader.capture"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.newwonwoo.downloader.capture"
        minSdk = 24
        targetSdk = 35
        versionCode = 4
        versionName = "2.0"
        buildConfigField("String", "BUILD_SHA", "\"$buildSha\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        getByName("debug") {
            storeFile = devKeystoreFile
            storePassword = "android"
            keyAlias = "videosave-dev"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
