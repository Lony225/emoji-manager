package dev.lony.emojimanager;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

/**
 * 应用自己的一点原生能力（Capacitor 官方插件没有的部分）：
 * - 把图片 / 文件放进系统剪贴板（content:// 地址，支持粘贴图片的聊天软件可以直接粘贴）
 * - 读系统剪贴板里的图片 / 文字（“粘贴剪贴板里的图片”）
 * - 接收其他应用“分享”过来的图片 / zip（相册、微信里的“分享到…”）
 * - emojimanager:// 协议链接
 * - 用系统浏览器打开链接
 */
@CapacitorPlugin(name = "EmojiNative")
public class EmojiNativePlugin extends Plugin {

    private static final String TAG = "EmojiNative";
    private static final String SCHEME = "emojimanager";
    private static final long MAX_FILE_BYTES = 100L * 1024 * 1024;

    /** 其他应用分享进来、还没被页面取走的内容 */
    private final List<Uri> pendingShare = new ArrayList<>();
    private String pendingShareText = null;
    private String pendingDeepLink = null;

    // ---------------------------------------------------------------- 接收分享 / 协议链接

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            collectShared(intent);
            consumeIntent();
            notifyListeners("received", new JSObject());
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null && SCHEME.equals(intent.getData().getScheme())) {
            pendingDeepLink = intent.getData().toString();
            consumeIntent();
            notifyListeners("deepLink", new JSObject());
        }
    }

    @SuppressWarnings("deprecation")
    private void collectShared(Intent intent) {
        synchronized (pendingShare) {
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) {
                    for (Uri u : list) if (u != null) pendingShare.add(u);
                }
            } else {
                Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (one != null) pendingShare.add(one);
            }
            // 有些应用只把地址放在 clipData 里
            if (pendingShare.isEmpty() && intent.getClipData() != null) {
                ClipData clip = intent.getClipData();
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) pendingShare.add(u);
                }
            }
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null && text.length() > 0) pendingShareText = text.toString();
            Logger.info(TAG, "收到分享：" + pendingShare.size() + " 个文件" + (pendingShareText != null ? "，带文字" : ""));
        }
    }

    /** 处理过的 intent 换成普通启动 intent，从最近任务重新打开时不会再导入一遍 */
    private void consumeIntent() {
        if (getActivity() != null) getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
    }

    @PluginMethod
    public void takePendingShare(PluginCall call) {
        List<Uri> uris;
        String text;
        synchronized (pendingShare) {
            uris = new ArrayList<>(pendingShare);
            pendingShare.clear();
            text = pendingShareText;
            pendingShareText = null;
        }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            JSObject f = readUri(uri);
            if (f != null) files.put(f);
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        ret.put("text", text == null ? "" : text);
        call.resolve(ret);
    }

    @PluginMethod
    public void takePendingDeepLink(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", pendingDeepLink);
        pendingDeepLink = null;
        call.resolve(ret);
    }

    // ---------------------------------------------------------------- 剪贴板

    /** 把一段图片数据（base64）写到缓存目录再放进剪贴板 */
    @PluginMethod
    public void copyImage(PluginCall call) {
        String data = call.getString("data");
        String mime = call.getString("mime", "image/png");
        String name = call.getString("name", "sticker.png");
        if (data == null) {
            call.reject("缺少图片数据");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "clipboard");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建缓存目录");
            File file = new File(dir, safeName(name));
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            List<File> files = new ArrayList<>();
            files.add(file);
            putFilesOnClipboard(files, mime);
            call.resolve();
        } catch (Exception e) {
            call.reject("复制失败：" + e.getMessage(), e);
        }
    }

    /** 把一个或多个本地文件（file:// 地址或绝对路径）放进剪贴板 */
    @PluginMethod
    public void copyFiles(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null || paths.length() == 0) {
            call.reject("没有要复制的文件");
            return;
        }
        try {
            List<File> files = new ArrayList<>();
            for (Object p : paths.toList()) {
                File f = toFile(String.valueOf(p));
                if (!f.exists()) throw new IOException("文件不存在：" + f.getName());
                files.add(f);
            }
            putFilesOnClipboard(files, null);
            call.resolve();
        } catch (Exception e) {
            call.reject("复制失败：" + e.getMessage(), e);
        }
    }

    private void putFilesOnClipboard(List<File> files, String mimeHint) {
        ContentResolver cr = getContext().getContentResolver();
        String authority = getContext().getPackageName() + ".fileprovider";
        ClipData clip = null;
        for (File f : files) {
            Uri uri = FileProvider.getUriForFile(getContext(), authority, f);
            String mime = mimeHint != null ? mimeHint : mimeOf(f.getName());
            if (clip == null) {
                clip = new ClipData(f.getName(), new String[] { mime }, new ClipData.Item(uri));
            } else {
                clip.addItem(new ClipData.Item(uri));
            }
        }
        if (clip == null) return;
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(clip);
    }

    /** 读系统剪贴板：图片 / 文件项读成 base64，文字和 HTML 原样返回 */
    @PluginMethod
    public void readClipboard(PluginCall call) {
        ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = cm.getPrimaryClip();
        JSArray files = new JSArray();
        String text = "";
        String html = "";
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                ClipData.Item item = clip.getItemAt(i);
                if (item.getUri() != null) {
                    JSObject f = readUri(item.getUri());
                    if (f != null) files.put(f);
                }
                if (text.isEmpty() && item.getText() != null) text = item.getText().toString();
                if (html.isEmpty() && item.getHtmlText() != null) html = item.getHtmlText();
            }
        }
        JSObject ret = new JSObject();
        ret.put("files", files);
        ret.put("text", text);
        ret.put("html", html);
        call.resolve(ret);
    }

    // ---------------------------------------------------------------- 其他

    /** 窗口和 WebView 的底色跟着界面主题走：旧版 WebView 不会铺到状态栏 / 导航栏下面，露出来的是这个底色 */
    @PluginMethod
    public void setBackground(PluginCall call) {
        String color = call.getString("color");
        if (color == null || getActivity() == null) {
            call.reject("缺少颜色");
            return;
        }
        try {
            final int parsed = Color.parseColor(color);
            getActivity().runOnUiThread(() -> {
                // Capacitor 把系统栏的留白加在 DecorView 的 padding 上，露出来的是 DecorView 的底色
                getActivity().getWindow().getDecorView().setBackgroundColor(parsed);
                getActivity().getWindow().setBackgroundDrawable(new ColorDrawable(parsed));
                if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().setBackgroundColor(parsed);
            });
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject("颜色格式不对：" + color);
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("缺少地址");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("没有可以打开这个链接的应用");
        }
    }

    // ---------------------------------------------------------------- 工具

    /** 把一个 content:// 或 file:// 读成 { name, mime, data(base64) }；读不了返回 null */
    private JSObject readUri(Uri uri) {
        ContentResolver cr = getContext().getContentResolver();
        String name = displayName(uri);
        String mime = null;
        try {
            mime = cr.getType(uri);
        } catch (Exception e) {
            Logger.warn(TAG, "读取类型失败 " + uri + ": " + e);
        }
        if (mime == null) mime = mimeOf(name);
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) {
                Logger.warn(TAG, "打不开 " + uri);
                return null;
            }
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(chunk)) > 0) {
                total += n;
                if (total > MAX_FILE_BYTES) {
                    Logger.warn(TAG, "文件超过 100 MB，跳过 " + uri);
                    return null;
                }
                buf.write(chunk, 0, n);
            }
            JSObject f = new JSObject();
            f.put("name", name);
            f.put("mime", mime);
            f.put("data", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
            return f;
        } catch (IOException | SecurityException e) {
            Logger.warn(TAG, "读取失败 " + uri + ": " + e);
            return null;
        }
    }

    private String displayName(Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) {
                        String n = c.getString(idx);
                        if (n != null && !n.isEmpty()) return n;
                    }
                }
            } catch (Exception ignored) {
                /* 有些提供者不支持查询，用路径末段 */
            }
        }
        String last = uri.getLastPathSegment();
        return last == null || last.isEmpty() ? "image" : last;
    }

    private static File toFile(String pathOrUri) {
        if (pathOrUri.startsWith("file:")) return new File(Uri.parse(pathOrUri).getPath());
        return new File(pathOrUri);
    }

    private static String mimeOf(String name) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(name));
        String mime = ext == null || ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime != null ? mime : "application/octet-stream";
    }

    private static String safeName(String name) {
        String clean = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return clean.isEmpty() ? "sticker.png" : clean;
    }

    @SuppressWarnings("unused")
    private static JSArray toArray(List<String> list) throws JSONException {
        return new JSArray(list);
    }
}
