package dev.lony.emojimanager;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;
import com.getcapacitor.Logger;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 局域网同步的安卓原生部分（和桌面版 electron/lan.ts 一一对应）：
 * - UDP 广播互相发现：每 3 秒广播一次本机信息，收到别人的就记为在线，十几秒没动静算离线
 * - 内置一个很小的 HTTP 服务：配对 / 同步请求转交给页面处理，图片文件直接读写资料目录
 * - 向其他设备发请求的客户端（HttpURLConnection）
 * 协议逻辑（差异比对、合并）在页面里（src/core/lan）。
 */
public class LanSyncService {

    private static final String TAG = "EmojiLan";
    private static final String APP_TAG = "emoji-manager";
    private static final int PROTO = 1;
    private static final int UDP_PORT = 28617;
    private static final int HTTP_PORT = 28618;
    private static final String HTTP_PATH = "/emoji-sync/v1";
    private static final long ANNOUNCE_MS = 3000;
    private static final long OFFLINE_MS = 12_000;
    private static final long MAX_JSON = 64L * 1024 * 1024;
    private static final long MAX_FILE = 100L * 1024 * 1024;
    private static final Pattern FILE_NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$");
    private static final Pattern TOKEN = Pattern.compile("^Bearer\\s+([A-Za-z0-9_-]{8,128})$");

    /** 页面那一侧：设备列表变化、转交请求 */
    public interface Host {
        void onDevices(JSONArray devices);
        /** 把请求交给页面处理；页面通过 respond() 回复。返回 null 表示页面不在 */
        boolean dispatch(String reqId, String kind, String from, String body);
    }

    public static class Response {
        public final int status;
        public final String body;

        public Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static class Device {
        String id;
        String name;
        String os;
        String version;
        String host;
        int port;
        long lastSeen;
    }

    private final Context context;
    private final Host hostCb;
    private final String version;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, Device> devices = new LinkedHashMap<>();
    private final Map<String, CompletableFuture<Response>> pending = new ConcurrentHashMap<>();

    private volatile String myId = "";
    private volatile String myName = "";
    private volatile Map<String, String> tokens = new HashMap<>();
    private volatile File libraryDir;

    private DatagramSocket udp;
    private ServerSocket server;
    private int port;
    private Thread udpThread;
    private Thread acceptThread;
    private ScheduledExecutorService timer;
    private WifiManager.MulticastLock multicastLock;
    private volatile boolean pairInFlight;

    public LanSyncService(Context context, Host hostCb, String version) {
        this.context = context.getApplicationContext();
        this.hostCb = hostCb;
        this.version = version;
    }

    public synchronized boolean isRunning() {
        return server != null;
    }

    public synchronized int getPort() {
        return port;
    }

    public void configure(String id, String name, Map<String, String> tokenByDevice) {
        boolean renamed = !name.equals(myName);
        myId = id;
        myName = name;
        tokens = tokenByDevice;
        if (renamed && udp != null) pool.execute(this::announce);
    }

    public synchronized int start(String id, String name, Map<String, String> tokenByDevice, File libraryDir) throws IOException {
        this.libraryDir = libraryDir;
        configure(id, name, tokenByDevice);
        if (server != null) return port;
        ServerSocket s;
        try {
            s = new ServerSocket();
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(HTTP_PORT));
        } catch (IOException e) {
            s = new ServerSocket(0);
        }
        server = s;
        port = s.getLocalPort();
        acceptThread = new Thread(this::acceptLoop, "emoji-lan-http");
        acceptThread.setDaemon(true);
        acceptThread.start();

        DatagramSocket u = new DatagramSocket(null);
        u.setReuseAddress(true);
        u.setBroadcast(true);
        u.bind(new InetSocketAddress(UDP_PORT));
        udp = u;
        udpThread = new Thread(this::udpLoop, "emoji-lan-udp");
        udpThread.setDaemon(true);
        udpThread.start();

        try {
            WifiManager wm = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                multicastLock = wm.createMulticastLock("emoji-lan");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception e) {
            Logger.warn(TAG, "无法获取组播锁：" + e);
        }

        timer = Executors.newSingleThreadScheduledExecutor();
        timer.scheduleWithFixedDelay(this::announce, 0, ANNOUNCE_MS, TimeUnit.MILLISECONDS);
        timer.scheduleWithFixedDelay(this::prune, 2500, 2500, TimeUnit.MILLISECONDS);
        Logger.info(TAG, "局域网同步已启动，端口 " + port);
        return port;
    }

    public synchronized void stop() {
        if (timer != null) {
            timer.shutdownNow();
            timer = null;
        }
        if (udp != null) {
            udp.close();
            udp = null;
        }
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
                /* 已关闭 */
            }
            server = null;
        }
        if (multicastLock != null) {
            try {
                if (multicastLock.isHeld()) multicastLock.release();
            } catch (Exception ignored) {
                /* 忽略 */
            }
            multicastLock = null;
        }
        for (CompletableFuture<Response> f : pending.values()) f.complete(new Response(503, "{\"error\":\"服务已停止\"}"));
        pending.clear();
        boolean had;
        synchronized (devices) {
            had = !devices.isEmpty();
            devices.clear();
        }
        if (had) emitDevices();
    }

    /** 页面处理完转交的请求 */
    public void respond(String reqId, int status, String body) {
        CompletableFuture<Response> f = pending.remove(reqId);
        if (f != null) f.complete(new Response(status, body));
    }

    public static String defaultName() {
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        if (model.isEmpty()) return "这台手机";
        if (!brand.isEmpty() && !model.toLowerCase(Locale.ROOT).startsWith(brand.toLowerCase(Locale.ROOT))) {
            return (Character.toUpperCase(brand.charAt(0)) + brand.substring(1) + " " + model);
        }
        return model;
    }

    /** 本机的局域网 IPv4 地址 */
    public static List<String> localAddresses() {
        List<String> out = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces == null) return out;
            for (NetworkInterface ni : Collections.list(ifaces)) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a.getAddress().length == 4 && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception e) {
            Logger.warn(TAG, "读取网卡失败：" + e);
        }
        return out;
    }

    // ---------------------------------------------------------------- 发现

    private List<InetAddress> broadcastAddresses() {
        List<InetAddress> out = new ArrayList<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            if (ifaces != null) {
                for (NetworkInterface ni : Collections.list(ifaces)) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                        InetAddress b = ia.getBroadcast();
                        if (b != null && !out.contains(b)) out.add(b);
                    }
                }
            }
        } catch (Exception e) {
            Logger.warn(TAG, "读取网卡失败：" + e);
        }
        return out;
    }

    private byte[] payload() {
        try {
            JSONObject j = new JSONObject();
            j.put("app", APP_TAG);
            j.put("proto", PROTO);
            j.put("id", myId);
            j.put("name", myName);
            j.put("os", "android");
            j.put("version", version);
            j.put("port", port);
            return j.toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException e) {
            return new byte[0];
        }
    }

    private void announce() {
        DatagramSocket u = udp;
        if (u == null || myId.isEmpty()) return;
        byte[] data = payload();
        for (InetAddress addr : broadcastAddresses()) {
            try {
                u.send(new DatagramPacket(data, data.length, addr, UDP_PORT));
            } catch (IOException e) {
                /* 这个网段发不出去就算了 */
            }
        }
    }

    private void udpLoop() {
        byte[] buf = new byte[2048];
        while (true) {
            DatagramSocket u = udp;
            if (u == null) return;
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try {
                u.receive(p);
            } catch (IOException e) {
                if (udp == null) return;
                continue;
            }
            try {
                onAnnounce(new String(p.getData(), p.getOffset(), p.getLength(), StandardCharsets.UTF_8), p.getAddress(), p.getPort());
            } catch (Exception e) {
                /* 不是我们的广播 */
            }
        }
    }

    private void onAnnounce(String text, InetAddress from, int fromPort) throws JSONException {
        JSONObject j = new JSONObject(text);
        if (!APP_TAG.equals(j.optString("app")) || j.optInt("proto") != PROTO) return;
        String id = j.optString("id", "");
        if (id.isEmpty() || id.equals(myId) || !j.has("port")) return;
        Device d = new Device();
        d.id = id;
        d.name = j.optString("name", "设备");
        if (d.name.isEmpty()) d.name = "设备";
        if (d.name.length() > 60) d.name = d.name.substring(0, 60);
        d.os = j.optString("os", "unknown");
        d.version = j.optString("version", "");
        d.host = from.getHostAddress();
        d.port = j.optInt("port");
        d.lastSeen = System.currentTimeMillis();
        boolean changed;
        boolean isNew;
        synchronized (devices) {
            Device prev = devices.get(id);
            isNew = prev == null;
            // 多网卡的机器会从几个地址轮流广播：先记住的地址只要还新鲜就一直用，免得列表来回抖动
            if (prev != null && !prev.host.equals(d.host) && d.lastSeen - prev.lastSeen < ANNOUNCE_MS + 1500) {
                d.host = prev.host;
                d.port = prev.port;
            }
            changed = isNew || !prev.name.equals(d.name) || !prev.host.equals(d.host) || prev.port != d.port;
            devices.put(id, d);
        }
        if (changed) emitDevices();
        if (isNew) {
            // 新出现的设备：直接回一条，让它不用等下一轮广播
            DatagramSocket u = udp;
            if (u != null) {
                byte[] data = payload();
                try {
                    u.send(new DatagramPacket(data, data.length, from, fromPort));
                } catch (IOException ignored) {
                    /* 忽略 */
                }
            }
        }
    }

    private void prune() {
        long cutoff = System.currentTimeMillis() - OFFLINE_MS;
        boolean changed = false;
        synchronized (devices) {
            for (String id : new ArrayList<>(devices.keySet())) {
                if (devices.get(id).lastSeen < cutoff) {
                    devices.remove(id);
                    changed = true;
                }
            }
        }
        if (changed) emitDevices();
    }

    private void emitDevices() {
        JSONArray arr = new JSONArray();
        synchronized (devices) {
            for (Device d : devices.values()) {
                try {
                    JSONObject j = new JSONObject();
                    j.put("id", d.id);
                    j.put("name", d.name);
                    j.put("os", d.os);
                    j.put("version", d.version);
                    j.put("host", d.host);
                    j.put("port", d.port);
                    j.put("lastSeen", d.lastSeen);
                    arr.put(j);
                } catch (JSONException ignored) {
                    /* 忽略 */
                }
            }
        }
        hostCb.onDevices(arr);
    }

    // ---------------------------------------------------------------- HTTP 服务

    private void acceptLoop() {
        while (true) {
            ServerSocket s = server;
            if (s == null) return;
            Socket client;
            try {
                client = s.accept();
            } catch (IOException e) {
                if (server == null) return;
                continue;
            }
            pool.execute(() -> handleConnection(client));
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            if (buf.size() > 16 * 1024) throw new IOException("请求头太长");
        }
        if (c < 0 && buf.size() == 0) return null;
        return buf.toString("UTF-8");
    }

    private void handleConnection(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(180_000);
            BufferedInputStream in = new BufferedInputStream(c.getInputStream());
            OutputStream out = c.getOutputStream();
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                sendJson(out, 400, "{\"error\":\"bad request\"}");
                return;
            }
            String method = parts[0];
            String path = parts[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
            long length = 0;
            try {
                length = Long.parseLong(headers.containsKey("content-length") ? headers.get("content-length") : "0");
            } catch (NumberFormatException ignored) {
                /* 当作 0 */
            }
            if ("100-continue".equalsIgnoreCase(headers.get("expect"))) {
                out.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                out.flush();
            }
            handleRequest(method, path, headers, in, length, out);
        } catch (Exception e) {
            Logger.warn(TAG, "处理请求出错：" + e);
        }
    }

    private void handleRequest(String method, String path, Map<String, String> headers, InputStream in, long length, OutputStream out) throws IOException {
        if (!path.startsWith(HTTP_PATH + "/")) {
            sendJson(out, 404, "{\"error\":\"not found\"}");
            return;
        }
        String sub = path.substring(HTTP_PATH.length());
        if (sub.equals("/pair") && method.equals("POST")) {
            if (pairInFlight) {
                sendJson(out, 409, "{\"error\":\"对方正在处理另一个配对请求\"}");
                return;
            }
            pairInFlight = true;
            try {
                String body = readBody(in, length, 64 * 1024);
                Response r = dispatch("pair", null, body, 100_000);
                sendJson(out, r.status, r.body);
            } finally {
                pairInFlight = false;
            }
            return;
        }
        String from = tokenOwner(headers.get("authorization"));
        if (from == null) {
            sendJson(out, 401, "{\"error\":\"未配对或配对已失效\"}");
            return;
        }
        if (sub.equals("/ping") && method.equals("GET")) {
            try {
                sendJson(out, 200, new JSONObject().put("id", myId).put("name", myName).toString());
            } catch (JSONException ignored) {
                sendJson(out, 200, "{}");
            }
            return;
        }
        if ((sub.equals("/begin") || sub.equals("/apply") || sub.equals("/end") || sub.equals("/unpair")) && method.equals("POST")) {
            String body = readBody(in, length, MAX_JSON);
            Response r = dispatch(sub.substring(1), from, body, sub.equals("/apply") ? 180_000 : 60_000);
            sendJson(out, r.status, r.body);
            return;
        }
        if (sub.startsWith("/file/") && (method.equals("PUT") || method.equals("GET"))) {
            String name = java.net.URLDecoder.decode(sub.substring("/file/".length()), "UTF-8");
            if (!FILE_NAME.matcher(name).matches() || libraryDir == null) {
                sendJson(out, 400, "{\"error\":\"无效的文件名\"}");
                return;
            }
            File file = new File(new File(libraryDir, "stickers"), name);
            if (method.equals("PUT")) {
                if (length > MAX_FILE) {
                    sendJson(out, 413, "{\"error\":\"文件超过 100 MB\"}");
                    return;
                }
                receiveFile(in, length, file);
                sendJson(out, 200, "{\"ok\":true}");
            } else {
                sendFile(out, file);
            }
            return;
        }
        sendJson(out, 404, "{\"error\":\"not found\"}");
    }

    private String tokenOwner(String auth) {
        if (auth == null) return null;
        java.util.regex.Matcher m = TOKEN.matcher(auth);
        if (!m.matches()) return null;
        String token = m.group(1);
        for (Map.Entry<String, String> e : tokens.entrySet()) {
            if (constantTimeEquals(e.getValue(), token)) return e.getKey();
        }
        return null;
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
        return diff == 0;
    }

    private static String readBody(InputStream in, long length, long max) throws IOException {
        if (length > max) throw new IOException("请求太大");
        ByteArrayOutputStream buf = new ByteArrayOutputStream((int) Math.min(length, 1 << 20));
        byte[] chunk = new byte[64 * 1024];
        long remaining = length;
        while (remaining > 0) {
            int n = in.read(chunk, 0, (int) Math.min(chunk.length, remaining));
            if (n < 0) throw new IOException("请求不完整");
            buf.write(chunk, 0, n);
            remaining -= n;
        }
        return buf.toString("UTF-8");
    }

    private Response dispatch(String kind, String from, String body, long timeoutMs) {
        String reqId = java.util.UUID.randomUUID().toString();
        CompletableFuture<Response> f = new CompletableFuture<>();
        pending.put(reqId, f);
        if (!hostCb.dispatch(reqId, kind, from, body)) {
            pending.remove(reqId);
            return new Response(503, "{\"error\":\"对方的应用没有打开\"}");
        }
        try {
            return f.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            pending.remove(reqId);
            return new Response(504, "{\"error\":\"对方没有在限定时间内回应\"}");
        } catch (Exception e) {
            pending.remove(reqId);
            return new Response(500, "{\"error\":\"内部错误\"}");
        }
    }

    private static void receiveFile(InputStream in, long length, File file) throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
        File tmp = new File(dir, file.getName() + ".part-" + System.nanoTime());
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            byte[] chunk = new byte[64 * 1024];
            long remaining = length;
            while (remaining > 0) {
                int n = in.read(chunk, 0, (int) Math.min(chunk.length, remaining));
                if (n < 0) throw new IOException("文件不完整");
                out.write(chunk, 0, n);
                remaining -= n;
            }
        } catch (IOException e) {
            tmp.delete();
            throw e;
        }
        if (file.exists() && !file.delete()) throw new IOException("无法覆盖旧文件");
        if (!tmp.renameTo(file)) throw new IOException("无法保存文件");
    }

    private static void sendFile(OutputStream out, File file) throws IOException {
        if (!file.isFile()) {
            sendJson(out, 404, "{\"error\":\"文件不存在\"}");
            return;
        }
        writeHead(out, 200, "application/octet-stream", file.length());
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] chunk = new byte[64 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) out.write(chunk, 0, n);
        }
        out.flush();
    }

    private static void writeHead(OutputStream out, int status, String contentType, long length) throws IOException {
        String reason = status == 200 ? "OK" : status == 400 ? "Bad Request" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : status == 413 ? "Payload Too Large" : status == 503 ? "Service Unavailable" : status == 504 ? "Gateway Timeout" : "Error";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\n" + "Content-Type: " + contentType + "\r\n" + "Content-Length: " + length + "\r\n" + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
    }

    private static void sendJson(OutputStream out, int status, String json) throws IOException {
        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        writeHead(out, status, "application/json; charset=utf-8", data.length);
        out.write(data);
        out.flush();
    }

    // ---------------------------------------------------------------- 客户端

    private HttpURLConnection open(String host, int port, String token, String method, String sub, int timeoutMs) throws IOException {
        URL url = new URL("http", host, port, HTTP_PATH + sub);
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(Math.min(timeoutMs, 15_000));
        c.setReadTimeout(timeoutMs);
        c.setUseCaches(false);
        c.setRequestProperty("Connection", "close");
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static String readAll(InputStream in, long max) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(chunk)) > 0) {
            total += n;
            if (total > max) throw new IOException("对方返回的内容太大");
            buf.write(chunk, 0, n);
        }
        return buf.toString("UTF-8");
    }

    private static InputStream responseStream(HttpURLConnection c) {
        try {
            return c.getInputStream();
        } catch (IOException e) {
            return c.getErrorStream();
        }
    }

    public Response request(String host, int port, String token, String sub, String body, int timeoutMs) throws IOException {
        byte[] data = body.getBytes(StandardCharsets.UTF_8);
        HttpURLConnection c = open(host, port, token, "POST", sub, timeoutMs);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        c.setFixedLengthStreamingMode(data.length);
        try {
            try (OutputStream out = c.getOutputStream()) {
                out.write(data);
            }
            int status = c.getResponseCode();
            String text = readAll(responseStream(c), MAX_JSON);
            return new Response(status, text);
        } finally {
            c.disconnect();
        }
    }

    public int upload(String host, int port, String token, String sub, File file) throws IOException {
        if (!file.isFile()) throw new IOException("文件不存在");
        HttpURLConnection c = open(host, port, token, "PUT", sub, 120_000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/octet-stream");
        c.setFixedLengthStreamingMode(file.length());
        try {
            try (OutputStream out = c.getOutputStream(); FileInputStream in = new FileInputStream(file)) {
                byte[] chunk = new byte[64 * 1024];
                int n;
                while ((n = in.read(chunk)) > 0) out.write(chunk, 0, n);
            }
            int status = c.getResponseCode();
            readAll(responseStream(c), 1 << 20);
            return status;
        } finally {
            c.disconnect();
        }
    }

    public int download(String host, int port, String token, String sub, File file) throws IOException {
        HttpURLConnection c = open(host, port, token, "GET", sub, 120_000);
        try {
            int status = c.getResponseCode();
            if (status != 200) {
                readAll(responseStream(c), 1 << 20);
                return status;
            }
            long declared = c.getContentLength();
            if (declared > MAX_FILE) throw new IOException("文件超过 100 MB");
            File dir = file.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("无法创建目录");
            File tmp = new File(dir, file.getName() + ".part-" + System.nanoTime());
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                byte[] chunk = new byte[64 * 1024];
                long total = 0;
                int n;
                while ((n = in.read(chunk)) > 0) {
                    total += n;
                    if (total > MAX_FILE) throw new IOException("文件超过 100 MB");
                    out.write(chunk, 0, n);
                }
            } catch (IOException e) {
                tmp.delete();
                throw e;
            }
            if (file.exists() && !file.delete()) throw new IOException("无法覆盖旧文件");
            if (!tmp.renameTo(file)) throw new IOException("无法保存文件");
            return 200;
        } finally {
            c.disconnect();
        }
    }

    /** 把网络异常换成用户看得懂的话 */
    public static String describe(Exception e) {
        String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        if (e instanceof java.net.ConnectException || msg.contains("ECONNREFUSED")) return "对方没有在接受连接（应用可能已关闭）";
        if (e instanceof java.net.SocketTimeoutException) return "连接对方超时";
        if (e instanceof java.net.NoRouteToHostException || msg.contains("EHOSTUNREACH") || msg.contains("ENETUNREACH")) return "连不上对方（不在同一网络，或被防火墙拦住）";
        return msg;
    }
}
