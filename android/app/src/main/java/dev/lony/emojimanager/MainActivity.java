package dev.lony.emojimanager;

import android.content.res.Configuration;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EmojiNativePlugin.class);
        super.onCreate(savedInstanceState);
        // 内容延伸到状态栏 / 导航栏下面，页面用 Capacitor 注入的 --safe-area-inset-* 留出位置。
        // 必须放在 super.onCreate 之后：提前调用会让窗口先按启动主题建好（带标题栏），Capacitor 再换成无标题栏主题就不起作用了
        EdgeToEdge.enable(this);
        // 页面画出来之前以及旧版 WebView 栏下面露出的底色：先按系统深浅色给一个，页面加载后会按设置再调
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = night ? 0xFF1B1C1F : 0xFFF4F4F5;
        if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().setBackgroundColor(bg);
    }
}
