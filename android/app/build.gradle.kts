import javax.inject.Inject
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.tasks.testing.Test

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

abstract class CopyComponentAssets @Inject constructor(
    private val files: FileSystemOperations
) : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val inputDirectory: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun copyAssets() {
        files.sync {
            from(inputDirectory) { into("components") }
            into(outputDirectory)
        }
    }
}

fun configString(name: String): String =
    "\"" + providers.gradleProperty(name).orElse("").get().replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val componentRoot = rootProject.projectDir.parentFile.resolve("packages/components")
val bundleComponents = tasks.register<Exec>("bundleComponents") {
    workingDir(rootProject.projectDir.parentFile)
    val npm = if (System.getProperty("os.name").startsWith("Windows")) listOf("cmd", "/d", "/c", "npm.cmd") else listOf("npm")
    commandLine(npm + listOf("run", "build", "--workspace", "@devpocket/components"))
    inputs.dir(componentRoot.resolve("src"))
    inputs.dir(componentRoot.resolve("web"))
    inputs.file(componentRoot.resolve("build.mjs"))
    inputs.file(componentRoot.resolve("package.json"))
    inputs.file(componentRoot.resolve("tsconfig.json"))
    inputs.file(rootProject.projectDir.parentFile.resolve("package-lock.json"))
    outputs.dir(componentRoot.resolve("dist"))
    outputs.upToDateWhen { false }
}

android {
    namespace = "dev.devpocket.app"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "dev.devpocket.app"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "FCM_APPLICATION_ID", configString("devpocket.fcm.applicationId"))
        buildConfigField("String", "FCM_API_KEY", configString("devpocket.fcm.apiKey"))
        buildConfigField("String", "FCM_PROJECT_ID", configString("devpocket.fcm.projectId"))
        buildConfigField("String", "FCM_SENDER_ID", configString("devpocket.fcm.senderId"))
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isDebuggable = true
            buildConfigField("boolean", "ALLOW_EMULATOR_HTTP", "true")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            buildConfigField("boolean", "ALLOW_EMULATOR_HTTP", "false")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    lint { warningsAsErrors = true }
    testOptions { unitTests.isIncludeAndroidResources = true }
    sourceSets.getByName("test").resources.directories.add(rootProject.projectDir.parentFile.resolve("test-fixtures").absolutePath)
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // These pinned vendor binaries contain no debug sections or symbol tables to strip.
        jniLibs.keepDebugSymbols += setOf("**/libandroidx.graphics.path.so", "**/libdatastore_shared_counter.so")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

tasks.withType<Test>().configureEach {
    jvmArgs("--enable-native-access=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
}

androidComponents.onVariants { variant ->
    val copyAssets = tasks.register<CopyComponentAssets>(
        "copy${variant.name.replaceFirstChar { it.uppercase() }}ComponentAssets"
    ) {
        dependsOn(bundleComponents)
        inputDirectory.set(componentRoot.resolve("dist/web"))
    }
    checkNotNull(variant.sources.assets).addGeneratedSourceDirectory(copyAssets, CopyComponentAssets::outputDirectory)
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.google.firebase:firebase-messaging:26.0.1")
    implementation("com.google.firebase:firebase-installations:20.0.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.fragment:fragment-ktx:1.9.1")
    implementation("androidx.webkit:webkit:1.18.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.1")
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("androidx.test:runner:1.7.0")
    testImplementation("androidx.test.ext:junit:1.3.0")
    testImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}
