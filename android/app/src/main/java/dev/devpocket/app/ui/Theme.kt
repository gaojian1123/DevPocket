package dev.devpocket.app.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

@Composable
fun PocketTheme(theme: String, content: @Composable () -> Unit) {
    val dark = theme == "dark" || (theme == "system" && isSystemInDarkTheme())
    val context = LocalContext.current
    val scheme = if (Build.VERSION.SDK_INT >= 31) {
        if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if (dark) darkColorScheme(primary = Color(0xFF67D9C1), secondary = Color(0xFFB3CBC4),
        background = Color(0xFF101517), surface = Color(0xFF101517))
    else lightColorScheme(primary = Color(0xFF006B5D), secondary = Color(0xFF4B635B),
        background = Color(0xFFF5FAF7), surface = Color(0xFFF5FAF7))
    MaterialTheme(colorScheme = scheme, content = content)
}
