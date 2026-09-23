package com.algermusic.app;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 自己那份返回键回调，退出时要临时关掉，见 {@link #exitFromBack()} */
    private final OnBackPressedCallback backCallback = new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
            askWebViewThenMaybeExit();
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 越早越好：Service 可能在 Activity 之前就被拉起来，日志器要能兜住
        AppLog.init(getApplicationContext());

        // 必须在 super.onCreate 之前注册：Bridge 在 super.onCreate 里就创建好了
        registerPlugin(InsetsPlugin.class);
        registerPlugin(NowPlayingPlugin.class);
        registerPlugin(DiagnosticsPlugin.class);
        super.onCreate(savedInstanceState);

        // 用 dispatcher 而不是覆写 onBackPressed()：targetSdk 33 起系统有了预测性返回，
        // 开启之后走的就不再是 onBackPressed()，只有 dispatcher 这条路两边都收得到。
        getOnBackPressedDispatcher().addCallback(this, backCallback);

        AppLog.log("MainActivity", "onCreate");
    }

    /**
     * 返回键（物理键 / 全面屏手势）先交给前端裁决。
     *
     * 基类没做任何处理，默认行为是直接 finish——全屏播放器、歌单页这些「还能再退一层」的地方
     * 一按返回整个 app 就没了。前端更清楚现在能不能退（它拿着路由和浮层状态），所以问它一句：
     * 它做掉了就算了，它说管不了（已经在主页面）才走默认的退出。
     */
    private void askWebViewThenMaybeExit() {
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) {
            exitFromBack();
            return;
        }

        // 前端是同步算完立刻返回布尔值的，回调下一轮消息循环就到，用户感觉不到延迟。
        // 拿不到 "true"（渲染进程没起来 / JS 抛异常 / 问的时候页面还没注册）一律按「管不了」
        // 处理：宁可多退一次 app，也不能让返回键卡死在一个退不掉的界面上。
        webView.evaluateJavascript(
            "window.__lyraHandleBack ? window.__lyraHandleBack() : false",
            value -> {
                if (!"true".equals(value)) {
                    exitFromBack();
                }
            }
        );
    }

    /**
     * 前端管不了这次返回，走系统默认的退出。
     *
     * 先把自己的回调关掉再交给 dispatcher——否则 dispatcher 转一圈又回到
     * {@link #askWebViewThenMaybeExit()}，退不出去还白问一次前端。
     */
    private void exitFromBack() {
        AppLog.log("MainActivity", "返回键未被前端消化，退出应用");
        backCallback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        backCallback.setEnabled(true);
    }
}
