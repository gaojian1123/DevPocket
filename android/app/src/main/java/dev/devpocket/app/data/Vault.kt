package dev.devpocket.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.IOException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class Vault(context: Context) {
    private val prefs = context.getSharedPreferences("devpocket_encrypted", Context.MODE_PRIVATE)
    private val alias = "devpocket.credentials.v1"

    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing is SecretKey) return existing
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }

    @Synchronized
    fun put(name: String, value: String?) {
        val editor = prefs.edit()
        if (value == null) {
            editor.remove(name)
        } else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            editor.putString(name, Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP))
        }
        if (!editor.commit()) throw IOException("Encrypted storage could not be persisted.")
    }

    @Synchronized
    fun get(name: String): String? {
        val value = prefs.getString(name, null) ?: return null
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.size >= 28) { "Encrypted storage is corrupt." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
    }

    fun accounts(): List<Account> = get("accounts")?.let { WireJson.decodeFromString(it) } ?: emptyList()
    fun saveAccounts(accounts: List<Account>) = put("accounts", WireJson.encodeToString(accounts))
}
