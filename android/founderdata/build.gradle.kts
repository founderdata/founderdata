import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SourcesJar

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.maven.publish)
}

android {
    namespace = "com.founderdata"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = false
    }
}

kotlin {
    jvmToolchain(17)
    explicitApi()
    // Apps on Kotlin 2.0 and later can read the metadata, and the stdlib dependency stays at 2.0.
    coreLibrariesVersion = "2.0.21"
    compilerOptions {
        apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
        languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_0)
    }
}

dependencies {
    implementation(libs.coroutines.android)
    implementation(libs.lifecycle.process)
    implementation(libs.installreferrer)

    // Optional: the app brings them. FounderData checks at runtime that the classes exist.
    compileOnly(libs.billing)
    compileOnly(libs.appset)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.mockwebserver)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.billing)
    testImplementation(libs.appset)
}

mavenPublishing {
    configure(AndroidSingleVariantLibrary(JavadocJar.Empty(), SourcesJar.Sources(), "release"))
    publishToMavenCentral()
    signAllPublications()
    coordinates("com.founderdata", "founderdata-android", providers.gradleProperty("VERSION_NAME").get())

    pom {
        name.set("FounderData for Android")
        description.set("Screens, goals, sessions and Google Play purchases from an Android app to a FounderData server.")
        inceptionYear.set("2026")
        url.set("https://github.com/founderdata/founderdata")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/licenses/MIT")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("founderdata")
                name.set("FounderData")
                url.set("https://github.com/founderdata")
            }
        }
        scm {
            url.set("https://github.com/founderdata/founderdata")
            connection.set("scm:git:git://github.com/founderdata/founderdata.git")
            developerConnection.set("scm:git:ssh://git@github.com/founderdata/founderdata.git")
        }
    }
}
