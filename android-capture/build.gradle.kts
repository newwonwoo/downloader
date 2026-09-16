plugins {
    id("com.android.application")
}

android {
    namespace = "com.newwonwoo.downloader.capture"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.newwonwoo.downloader.capture"
        minSdk = 24
        targetSdk = 35
        versionCode = 4
        versionName = "1.3"
    }

    buildTypes {
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
