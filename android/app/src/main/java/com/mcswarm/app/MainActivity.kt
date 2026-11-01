package com.mcswarm.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val allowed = BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.BIOMETRIC_WEAK

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(0xFF12161A.toInt())
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
        }
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Bridge(), "Android")
        web.loadUrl("file:///android_asset/index.html")
    }

    private fun js(code: String) = web.post { web.evaluateJavascript(code, null) }

    inner class Bridge {
        @JavascriptInterface
        fun canAuth(): Boolean =
            BiometricManager.from(this@MainActivity).canAuthenticate(allowed) == BiometricManager.BIOMETRIC_SUCCESS

        // Xác nhận vân tay cho nút Dừng khẩn cấp; kết quả trả về window.onAuth(ok, msg)
        @JavascriptInterface
        fun authenticate() {
            runOnUiThread {
                if (!canAuth()) {
                    js("window.onAuth(false," + JSONObject.quote("thiết bị chưa cài vân tay") + ")")
                    return@runOnUiThread
                }
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Dừng khẩn cấp")
                    .setSubtitle("Xác nhận vân tay để dừng toàn bộ bot")
                    .setAllowedAuthenticators(allowed)
                    .setNegativeButtonText("Huỷ")
                    .build()
                val prompt = BiometricPrompt(
                    this@MainActivity, ContextCompat.getMainExecutor(this@MainActivity),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            js("window.onAuth(true)")
                        }
                        override fun onAuthenticationError(code: Int, msg: CharSequence) {
                            js("window.onAuth(false," + JSONObject.quote(msg.toString()) + ")")
                        }
                    })
                prompt.authenticate(info)
            }
        }
    }
}
