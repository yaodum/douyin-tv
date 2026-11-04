package com.qoder.douyintv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 抖音TV —— 把抖音网页版装进电视的 WebView 壳。
 *
 * 职责划分：
 *   Java 侧  = 遥控器按键、真全屏回调、内核自检、登录态持久化
 *   JS 侧    = 找出当前视频、把它提升为全屏画面、上下键切换推荐流
 * 两边的契约是 window.__dtv（assets/douyin-tv.js）和 AndroidTV 桥接对象。
 */
public class MainActivity extends Activity {

    private static final String TAG = "DouyinTV";

    /** 首选页：抖音精选/推荐流。登录后会记住登录态，下次开机直进。 */
    private static final String START_URL = "https://www.douyin.com/";

    /**
     * 伪装成桌面 Chrome。抖音网页版会对移动/WebView UA 降级或弹验证，
     * 这条必须保留；改它之前先想清楚要的是桌面版还是移动版页面。
     */
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    private static final String JS_ASSET = "douyin-tv.js";
    private static final String PREFS = "dtv";
    private static final String PREF_URL = "url";

    private FrameLayout root;
    private FrameLayout customContainer;
    private TextView statusOverlay;
    private WebView webView;
    private Handler ui;
    private String injectedJs = "";
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;

    /** JS 上报的影院态：true 时遥控器按键交给推荐流逻辑，false 时按键交回网页做焦点导航。 */
    private volatile boolean cinema = false;
    private volatile String lastState = "";
    /** 内核版本警告：置位后不让页面加载完成把提示冲掉。 */
    private volatile boolean engineWarning = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        ui = new Handler(Looper.getMainLooper());

        root = findViewById(R.id.root);
        customContainer = findViewById(R.id.custom_container);
        statusOverlay = findViewById(R.id.status_overlay);
        webView = findViewById(R.id.webview);

        applyWindowFlags();
        setupWebView();
        loadBridgeScript();

        String url = prefs().getString(PREF_URL, START_URL);
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(url);
        }

        reportEngine();
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 抖音用它存登录/偏好，不开会一直弹登录
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // 关键：免手势自动播放
        s.setUserAgentString(DESKTOP_UA);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF); // 别让系统反色把视频蒙层搞花
        }

        webView.setBackgroundColor(Color.BLACK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.requestFocus(View.FOCUS_DOWN);
        // 允许 chrome://inspect 远程调试（adb 连上电视后可用），排查页面问题全靠它
        WebView.setWebContentsDebuggingEnabled(true);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new Bridge(), "AndroidTV");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                prefs().edit().putString(PREF_URL, url).apply();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 注入顺序固定为 脚本 → boot()，boot 负责把影院态重新拉起来
                eval(injectedJs);
                eval("window.__dtv && __dtv.boot(" + quote(view.getSettings().getUserAgentString()) + ")");
                hideStatus();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showStatus("主页面加载失败\n"
                            + "code=" + error.getErrorCode() + "  " + error.getDescription()
                            + "\n" + request.getUrl());
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // 电视盒子常见系统时间/证书问题；这里保守放行主站证书错误会掩盖风险，
                // 所以只打印日志并交由用户判断，不盲目 proceed()。
                Log.w(TAG, "SSL error: " + error);
                showStatus("证书校验失败：" + error.getUrl() + "\n请检查电视系统时间是否正确");
                handler.cancel();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    return false; // 留在本应用内
                }
                // snssdk1128:// 之类是"去抖音App打开"的跳转，电视上没有，直接吞掉
                Log.i(TAG, "blocked external scheme: " + url);
                toast("电视端已忽略该跳转");
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                customContainer.addView(view);
                customContainer.setVisibility(View.VISIBLE);
                webView.setVisibility(View.GONE);
                cinema = true;
                applyWindowFlags();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) {
                    return;
                }
                customContainer.removeView(customView);
                customContainer.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                customView = null;
                WebChromeClient.CustomViewCallback cb = customCallback;
                customCallback = null;
                if (cb != null) {
                    cb.onCustomViewHidden();
                }
                cinema = false;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // 抖音网页版偶尔申请媒体权限（直播/拍摄入口），这里按需放行
                try {
                    request.grant(request.getResources());
                } catch (RuntimeException e) {
                    request.deny();
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
                toast(message);
                result.confirm();
                return true;
            }
        });
    }

    /** 读取 assets 里的 JS 一次，缓存在内存，省得每页重复 IO。 */
    private void loadBridgeScript() {
        try (java.io.InputStream in = getAssets().open(JS_ASSET);
             java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            injectedJs = "javascript:" + out.toString("UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "load " + JS_ASSET + " failed", e);
            injectedJs = "javascript:void(0)";
        }
    }

    // ------------------------------------------------------------------ 遥控器

    /**
     * 按键契约（影院态，也就是正常刷视频时）：
     *   ↑ / ↓          上一条 / 下一条（核心需求）
     *   确认 / Enter    短按暂停·播放，长按切换画面（完整显示 <-> 铺满裁切）
     *   ← / →          后退 / 前进 10 秒
     *   菜单 MENU       短按影院态开关（网页卡住时自救），长按自检浮层
     *   长按菜单        自检浮层：内核版本、UA、当前状态、切换策略
     *   返回            关闭浮层 / 退出影院态 / 后退 / 退出应用
     * 非影院态时方向键原样交给网页，方便扫码登录页那种焦点导航。
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean first = event.getRepeatCount() == 0;
        int kc = event.getKeyCode();

        switch (kc) {
            case KeyEvent.KEYCODE_DPAD_UP:
                if (cinema) {
                    if (down && first) eval("window.__dtv&&__dtv.swipe(-1)");
                    return true;
                }
                break;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                if (cinema) {
                    if (down && first) eval("window.__dtv&&__dtv.swipe(1)");
                    return true;
                }
                break;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_SPACE:
                if (cinema) {
                    if (down) {
                        // 长按（连发计数达标）= 在"完整显示（左右黑边）"与"铺满（上下裁切）"间切换
                        if (event.getRepeatCount() >= 5 && !centerConsumedAsLong) {
                            centerConsumedAsLong = true;
                            eval("window.__dtv&&__dtv.toggleFit()");
                        }
                    } else {
                        // 短按 = 暂停/播放：等抬起再执行，避免长按时先闪一下暂停
                        if (!centerConsumedAsLong) eval("window.__dtv&&__dtv.togglePlay()");
                        centerConsumedAsLong = false;
                    }
                    return true;
                }
                break;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (cinema) {
                    if (down && first) eval("window.__dtv&&__dtv.seek(-10)");
                    return true;
                }
                break;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (cinema) {
                    if (down && first) eval("window.__dtv&&__dtv.seek(10)");
                    return true;
                }
                break;
            case KeyEvent.KEYCODE_MENU:
                if (down) {
                    // 长按（连发计数达到阈值）= 自检浮层；短按 = 影院态开关
                    if (event.getRepeatCount() >= 5) {
                        if (!menuConsumedAsLong) {
                            menuConsumedAsLong = true;
                            showStatus(diagnostics());
                        }
                    } else if (first) {
                        menuConsumedAsLong = false;
                    }
                    return true;
                }
                // ACTION_UP：没被当成长按就执行短按动作
                if (!menuConsumedAsLong) {
                    eval("window.__dtv&&__dtv.toggleCinema()");
                }
                menuConsumedAsLong = false;
                return true;
            case KeyEvent.KEYCODE_BACK:
                if (down && first) {
                    handleBack();
                    return true;
                }
                return true; // 吃掉 ACTION_UP，避免重复退出
            default:
                break;
        }
        return super.dispatchKeyEvent(event);
    }

    private boolean menuConsumedAsLong = false;
    private boolean centerConsumedAsLong = false;

    private void handleBack() {
        if (customView != null) {
            onHideCustomViewCompat();
            return;
        }
        if (statusOverlay.getVisibility() == View.VISIBLE) {
            engineWarning = false;
            hideStatus();
            return;
        }
        if (cinema) {
            eval("window.__dtv&&__dtv.setCinema(false)");
            cinema = false;
            toast("已退出影院态，方向键恢复网页导航");
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        finish();
    }

    /** 网页自己请求的 fullscreen 与我们的影院态共用一条退出路径。 */
    private void onHideCustomViewCompat() {
        if (customView != null && customCallback != null) {
            customContainer.removeView(customView);
            customContainer.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            customView = null;
            customCallback.onCustomViewHidden();
            customCallback = null;
            cinema = false;
        }
    }

    // ---------------------------------------------------------------- 状态与生命周期

    private void applyWindowFlags() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        @SuppressWarnings("deprecation")
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        root.setSystemUiVisibility(flags);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyWindowFlags();
            webView.requestFocus();
        }
    }

    @Override
    protected void onPause() {
        eval("window.__dtv&&__dtv.pause()");
        webView.pauseTimers();
        webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.resumeTimers();
        webView.onResume();
        applyWindowFlags();
        // 回到前台时抖音可能已经把播放器重置，重新绑一次
        eval("window.__dtv&&__dtv.rebind()");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 工具

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void eval(final String js) {
        if (webView == null) {
            return;
        }
        String script = js.startsWith("javascript:") ? js : "javascript:" + js;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            webView.evaluateJavascript(script, null);
        } else {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    webView.evaluateJavascript(script, null);
                }
            });
        }
    }

    private static String quote(String raw) {
        if (raw == null) {
            return "''";
        }
        return "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private void toast(final String text) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void showStatus(final String text) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                statusOverlay.setText(text);
                statusOverlay.setVisibility(View.VISIBLE);
            }
        });
    }

    private void hideStatus() {
        ui.post(new Runnable() {
            @Override
            public void run() {
                // 内核过旧的警告属于"必须看见"的信息，不被页面加载完成清掉，只由返回键关闭
                if (engineWarning) {
                    return;
                }
                statusOverlay.setVisibility(View.GONE);
            }
        });
    }

    /** 内核太老时抖音网页版会白屏，这一条让电视自己把病情说出来。 */
    private void reportEngine() {
        PackageInfo pi = null;
        try {
            pi = WebView.getCurrentWebViewPackage();
        } catch (Exception ignored) {
        }
        String ver = pi == null ? "未知" : pi.versionName;
        int major = parseMajor(ver);
        Log.i(TAG, "WebView provider=" + (pi == null ? "null" : pi.packageName) + " version=" + ver);
        if (pi == null || major < 90) {
            engineWarning = true;
            showStatus("系统 WebView 偏旧：" + (pi == null ? "未找到内核" : pi.packageName + " " + ver)
                    + "\n抖音网页版需要 Chrome 90+ 内核，若页面空白请先升级“Android System WebView”。\n"
                    + "按菜单键可关闭此提示。");
        }
    }

    private static int parseMajor(String version) {
        try {
            return Integer.parseInt(version.split("\\.")[0]);
        } catch (Exception e) {
            return 0;
        }
    }

    private String diagnostics() {
        PackageInfo pi = null;
        try {
            pi = WebView.getCurrentWebViewPackage();
        } catch (Exception ignored) {
        }
        return "自检\n"
                + "内核: " + (pi == null ? "未知" : pi.packageName + " " + pi.versionName) + "\n"
                + "UA: " + webView.getSettings().getUserAgentString() + "\n"
                + "地址: " + webView.getUrl() + "\n"
                + "影院态: " + cinema + "\n"
                + "页面状态: " + (TextUtils.isEmpty(lastState) ? "（JS 未上报，说明内核不支持或脚本未注入）" : lastState);
    }

    // ---------------------------------------------------------------- JS 桥

    /** assets/douyin-tv.js 通过 window.AndroidTV 调用这里；方法运行在 JavaBridge 线程，故统一 post 回主线程。 */
    private class Bridge {

        @JavascriptInterface
        public void onState(final String json) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    lastState = json;
                    try {
                        org.json.JSONObject o = new org.json.JSONObject(json);
                        cinema = o.optBoolean("cinema", cinema);
                    } catch (Exception e) {
                        Log.w(TAG, "bad state json: " + json);
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String text) {
            MainActivity.this.toast(text == null ? "" : text);
        }

        @JavascriptInterface
        public void log(final String text) {
            Log.i(TAG, "[js] " + text);
        }
    }
}
