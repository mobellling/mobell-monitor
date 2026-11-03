package com.mobell.monitor

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores the GitHub token encrypted with an AES/GCM key that never leaves the
 * Android Keystore. The stored value is base64(iv + ciphertext) inside the
 * "mobell" SharedPreferences; the plaintext token is never exposed to JS.
 */
class TokenStore(context: Context) {

    private val prefs = context.getSharedPreferences(WidgetState.PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    fun saveToken(token: String) {
        synchronized(lock) {
            val payload = encrypt(token)
            prefs.edit().putString(KEY_TOKEN, payload).apply()
        }
    }

    fun getToken(): String? = synchronized(lock) {
        val payload = prefs.getString(KEY_TOKEN, null) ?: return null
        runCatching { decrypt(payload) }.getOrNull()
    }

    fun clear() {
        synchronized(lock) {
            prefs.edit().remove(KEY_TOKEN).apply()
        }
    }

    fun hasToken(): Boolean = synchronized(lock) {
        val payload = prefs.getString(KEY_TOKEN, null)
        !payload.isNullOrEmpty() && runCatching { decrypt(payload) }.isSuccess
    }

    private fun encrypt(plainText: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val cipherText = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        val combined = ByteArray(iv.size + cipherText.size)
        System.arraycopy(iv, 0, combined, 0, iv.size)
        System.arraycopy(cipherText, 0, combined, iv.size, cipherText.size)
        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String {
        val combined = Base64.decode(encoded, Base64.NO_WRAP)
        require(combined.size > IV_LENGTH) { "密文格式无效" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(GCM_TAG_BITS, combined, 0, IV_LENGTH),
        )
        return String(cipher.doFinal(combined, IV_LENGTH, combined.size - IV_LENGTH), Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "mobell_github_token"
        const val KEY_TOKEN = "github_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_LENGTH = 12
        const val GCM_TAG_BITS = 128
    }
}
