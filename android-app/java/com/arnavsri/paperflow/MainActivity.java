package com.arnavsri.paperflow;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private static final String VIRTUAL_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + VIRTUAL_HOST + "/index.html";
    private static final String CHANNEL_ID = "paperflow_alerts";
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;
    private static final int NOTIF_PERMISSION_CODE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private int notificationIdCounter = 2000;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        applySystemBarColors(false);
        createNotificationChannel();
        requestNotificationPermissionIfNeeded();

        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#f5f0e8"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#f5f0e8"));
        configureWebView(webView);

        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        setContentView(rootLayout);

        String postIdFromIntent = getIntent() != null ? getIntent().getStringExtra("postId") : null;
        if (postIdFromIntent != null && !postIdFromIntent.isEmpty()) {
            webView.loadUrl(START_URL + "?post=" + Uri.encode(postIdFromIntent));
        } else {
            webView.loadUrl(START_URL);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && webView != null) {
            final String postId = intent.getStringExtra("postId");
            if (postId != null && !postId.isEmpty()) {
                final String safeId = postId.replace("'", "\\'");
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        webView.evaluateJavascript(
                                "if(window.jumpToFlowFromReply){window.jumpToFlowFromReply('" + safeId + "');}",
                                null
                        );
                    }
                });
            }
        }
    }

    private void applySystemBarColors(boolean isDark) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window window = getWindow();
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            int statusColor = Color.parseColor(isDark ? "#12100e" : "#1a1209");
            int navColor = Color.parseColor(isDark ? "#1c1915" : "#fffdf7");
            window.setStatusBarColor(statusColor);
            window.setNavigationBarColor(navColor);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        "Paper Flow Replies & Messages",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Live notifications for replies to your flows and encrypted Paper Messages");
                channel.enableVibration(true);
                nm.createNotificationChannel(channel);
            }
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIF_PERMISSION_CODE);
            }
        }
    }

    private void configureWebView(final WebView wv) {
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Disallow pinch-to-zoom multi-finger gestures completely
        wv.setOnTouchListener(new android.view.View.OnTouchListener() {
            @Override
            public boolean onTouch(android.view.View v, android.view.MotionEvent event) {
                if (event.getPointerCount() > 1) {
                    return true;
                }
                return false;
            }
        });

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(wv, true);
        }

        wv.addJavascriptInterface(new AndroidBridge(), "PaperFlowAndroid");

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) {
                    return null;
                }
                Uri uri = request.getUrl();
                if (!VIRTUAL_HOST.equalsIgnoreCase(uri.getHost())) {
                    return null;
                }

                String path = uri.getPath();
                if (path == null || path.isEmpty() || "/".equals(path)) {
                    path = "/index.html";
                }
                while (path.startsWith("/")) {
                    path = path.substring(1);
                }

                String assetPath = "www/" + path;
                try {
                    InputStream is = getAssets().open(assetPath);
                    String mimeType = guessMimeType(path);
                    String encoding = mimeType.startsWith("text/") || mimeType.contains("javascript") || mimeType.contains("json") || mimeType.contains("svg")
                            ? "UTF-8"
                            : null;
                    WebResourceResponse response = new WebResourceResponse(mimeType, encoding, is);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        Map<String, String> headers = new HashMap<String, String>();
                        headers.put("Access-Control-Allow-Origin", "*");
                        headers.put("Cache-Control", "no-cache");
                        response.setResponseHeaders(headers);
                    }
                    return response;
                } catch (Exception e) {
                    return null;
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) {
                    return false;
                }
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host != null && VIRTUAL_HOST.equalsIgnoreCase(host)) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(intent);
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallbackParam, FileChooserParams fileChooserParams) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = filePathCallbackParam;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");

                try {
                    startActivityForResult(Intent.createChooser(intent, "Select Image"), FILE_CHOOSER_RESULT_CODE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        wv.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(i);
                } catch (Exception ignored) {
                }
            }
        });
    }

    private String guessMimeType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "(function(){ return Boolean(window.handleAndroidBackButton && window.handleAndroidBackButton()); })()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if ("true".equals(value)) {
                                return;
                            }
                            if (webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                MainActivity.super.onBackPressed();
                            }
                        }
                    }
            );
        } else {
            super.onBackPressed();
        }
    }

    public class AndroidBridge {
        @JavascriptInterface
        public boolean isNativeAndroidApp() {
            return true;
        }

        @JavascriptInterface
        public int getAppVersionCode() {
            return 2;
        }

        @JavascriptInterface
        public String getAppVersionName() {
            return "1.0.1";
        }

        @JavascriptInterface
        public void setDarkMode(final boolean isDark) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applySystemBarColors(isDark);
                    if (webView != null) {
                        webView.setBackgroundColor(Color.parseColor(isDark ? "#12100e" : "#f5f0e8"));
                    }
                }
            });
        }

        @JavascriptInterface
        public void vibrate(final int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null && v.hasVibrator()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v.vibrate(VibrationEffect.createOneShot(Math.max(20, ms), VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        v.vibrate(Math.max(20, ms));
                    }
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void showNotification(final String title, final String body, final String postId) {
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;

                Intent intent = new Intent(MainActivity.this, MainActivity.class);
                intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                if (postId != null && !postId.isEmpty()) {
                    intent.putExtra("postId", postId);
                }

                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    flags |= PendingIntent.FLAG_IMMUTABLE;
                }
                int reqCode = ++notificationIdCounter;
                PendingIntent pi = PendingIntent.getActivity(MainActivity.this, reqCode, intent, flags);

                Notification.Builder builder;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    builder = new Notification.Builder(MainActivity.this, CHANNEL_ID);
                } else {
                    builder = new Notification.Builder(MainActivity.this);
                    builder.setPriority(Notification.PRIORITY_HIGH);
                }

                builder.setSmallIcon(R.mipmap.ic_launcher)
                        .setContentTitle(title != null ? title : "Paper Flow")
                        .setContentText(body != null ? body : "")
                        .setAutoCancel(true)
                        .setContentIntent(pi);

                nm.notify(reqCode, builder.build());
            } catch (Exception ignored) {
            }
        }
    }
}
