plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Fire OS 5 (API 22) through current Fire OS. Media3 1.4.x is the last line that builds against
// compileSdk 34; 1.5+ requires compileSdk 35.
android {
    namespace = "com.tkbox.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tkbox.tv"
        minSdk = 22
        targetSdk = 34
        versionCode = 10000
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        debug {
            // LAN development servers run plain HTTP; release builds must use HTTPS.
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "true")
        }
        release {
            isMinifyEnabled = false
            buildConfigField("boolean", "ALLOW_CLEARTEXT", "false")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
}
