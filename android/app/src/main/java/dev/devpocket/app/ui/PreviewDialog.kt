package dev.devpocket.app.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.devpocket.app.data.FilePreview
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext

@Composable
fun PreviewDialog(file: FilePreview, dismiss: () -> Unit, save: () -> Unit) {
    var image by remember(file) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(file) { mutableStateOf<String?>(null) }
    LaunchedEffect(file) {
        if (file.mime.startsWith("image/")) {
            try {
                image = withContext(Dispatchers.Default) {
                    val bytes = Base64.decode(file.content, Base64.DEFAULT)
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0 &&
                        bounds.outWidth.toLong() * bounds.outHeight <= 50_000_000) { "图片尺寸不受支持。" }
                    val options = BitmapFactory.Options()
                    var sample = 1
                    while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
                    options.inSampleSize = sample
                    (BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("图片解码失败。")).asImageBitmap()
                }
            } catch (failure: CancellationException) { throw failure }
            catch (failure: Exception) { error = failure.message ?: "无法安全解码此图片。" }
        }
    }
    AlertDialog(onDismissRequest = dismiss, title = { Text(file.name, maxLines = 2) },
        text = {
            LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Text("${file.mime} · ${file.size / 1024} KiB · 不可信文件内容", style = MaterialTheme.typography.labelSmall) }
                when {
                    file.encoding == "utf8" -> item {
                        SelectionContainer { Text(file.content, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                    }
                    file.mime.startsWith("image/") -> item {
                        if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error)
                        else if (image == null) CircularProgressIndicator()
                        else Image(image!!, contentDescription = "附件预览：${file.name}", contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp))
                    }
                    else -> item { Text("此文档不会在应用内执行或通过 WebView 加载。可保存到你选择的位置后，使用可信系统应用打开。") }
                }
            }
        },
        confirmButton = { TextButton(onClick = save) { Text("另存为") } },
        dismissButton = { TextButton(onClick = dismiss) { Text("关闭") } })
}
