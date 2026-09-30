package it.beyondata.energiacasa;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Iterator;

public class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(6, 16, 29));
        getWindow().setNavigationBarColor(Color.rgb(6, 16, 29));

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new EnergyBridge(this, webView), "EnergyBridge");
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    static class EnergyBridge {
        private final SharedPreferences prefs;
        private final WebView webView;

        EnergyBridge(Context context, WebView webView) {
            this.prefs = context.getSharedPreferences("energy_config", Context.MODE_PRIVATE);
            this.webView = webView;
        }

        @JavascriptInterface
        public String getConfig() {
            try {
                JSONObject j = new JSONObject();
                j.put("demo", prefs.getBoolean("demo", true));
                j.put("solarSiteId", prefs.getString("solarSiteId", ""));
                j.put("solarApiKey", prefs.getString("solarApiKey", ""));
                j.put("shellyHost", prefs.getString("shellyHost", ""));
                j.put("shellyAuthKey", prefs.getString("shellyAuthKey", ""));
                j.put("shellyDeviceId", prefs.getString("shellyDeviceId", ""));
                return j.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void saveConfig(String json) {
            try {
                JSONObject j = new JSONObject(json);
                prefs.edit()
                        .putBoolean("demo", j.optBoolean("demo", true))
                        .putString("solarSiteId", j.optString("solarSiteId", ""))
                        .putString("solarApiKey", j.optString("solarApiKey", ""))
                        .putString("shellyHost", j.optString("shellyHost", ""))
                        .putString("shellyAuthKey", j.optString("shellyAuthKey", ""))
                        .putString("shellyDeviceId", j.optString("shellyDeviceId", ""))
                        .apply();
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void requestData() {
            new Thread(() -> {
                JSONObject result;
                try {
                    boolean demo = prefs.getBoolean("demo", true);
                    double solarW;
                    double useW;
                    if (demo) {
                        double t = System.currentTimeMillis() / 1000.0;
                        solarW = Math.max(0, 3420 + Math.sin(t / 18.0) * 90 + Math.sin(t / 7.0) * 35);
                        useW = Math.max(120, 1150 + Math.sin(t / 9.0) * 95 + Math.sin(t / 3.7) * 30);
                    } else {
                        solarW = getSolarEdgeW();
                        useW = getShellyW();
                    }
                    result = new JSONObject();
                    result.put("ok", true);
                    result.put("demo", demo);
                    result.put("timestamp", Instant.now().toString());
                    result.put("inputKw", round(solarW / 1000.0));
                    result.put("usageKw", round(useW / 1000.0));
                    result.put("exportKw", round(Math.max(0, solarW - useW) / 1000.0));
                } catch (Exception e) {
                    result = new JSONObject();
                    try {
                        result.put("ok", false);
                        result.put("message", e.getMessage() == null ? "Errore di connessione" : e.getMessage());
                    } catch (Exception ignored) { }
                }
                final String payload = result.toString();
                webView.post(() -> webView.evaluateJavascript("window.onNativeData(" + payload + ")", null));
            }).start();
        }

        private double getSolarEdgeW() throws Exception {
            String siteId = prefs.getString("solarSiteId", "").trim();
            String apiKey = prefs.getString("solarApiKey", "").trim();
            if (siteId.isEmpty() || apiKey.isEmpty()) throw new Exception("Inserisci Site ID e API key SolarEdge nelle impostazioni.");

            String endpoint = "https://monitoringapi.solaredge.com/site/" +
                    URLEncoder.encode(siteId, "UTF-8") + "/currentPowerFlow?api_key=" +
                    URLEncoder.encode(apiKey, "UTF-8");
            JSONObject root = new JSONObject(http("GET", endpoint, null));
            JSONObject flow = root.optJSONObject("siteCurrentPowerFlow");
            if (flow == null) throw new Exception("SolarEdge non ha restituito il flusso di potenza.");
            JSONObject pv = flow.optJSONObject("PV");
            if (pv == null || !pv.has("currentPower")) throw new Exception("SolarEdge: produzione FV non disponibile.");
            double value = pv.getDouble("currentPower");
            String unit = flow.optString("unit", "kW");
            return unit.equalsIgnoreCase("W") ? value : value * 1000.0;
        }

        private double getShellyW() throws Exception {
            String host = prefs.getString("shellyHost", "").trim();
            String auth = prefs.getString("shellyAuthKey", "").trim();
            String device = prefs.getString("shellyDeviceId", "").trim();
            if (host.isEmpty() || auth.isEmpty() || device.isEmpty()) throw new Exception("Inserisci Host, Authorization key e Device ID Shelly nelle impostazioni.");
            host = host.replaceFirst("^https?://", "").replaceAll("/+$", "");
            String endpoint = "https://" + host + "/v2/devices/api/get?auth_key=" + URLEncoder.encode(auth, "UTF-8");

            JSONObject body = new JSONObject();
            body.put("ids", new JSONArray().put(device));
            body.put("select", new JSONArray().put("status"));
            String response = http("POST", endpoint, body.toString());
            JSONArray arr = new JSONArray(response);
            if (arr.length() == 0) throw new Exception("Shelly non ha restituito lo stato del dispositivo.");
            JSONObject item = arr.getJSONObject(0);
            if (item.optInt("online", 1) == 0) throw new Exception("Shelly risulta offline.");
            JSONObject status = item.optJSONObject("status");
            if (status == null) status = item;
            Double power = findPower(status);
            if (power == null) throw new Exception("Non trovo la potenza istantanea nello stato Shelly.");
            return power;
        }

        private Double findPower(Object value) {
            if (value instanceof JSONObject) {
                JSONObject o = (JSONObject) value;
                String[] preferred = {"total_act_power", "act_power", "apower", "power"};
                for (String key : preferred) {
                    if (o.has(key)) {
                        Object v = o.opt(key);
                        if (v instanceof Number) return ((Number) v).doubleValue();
                    }
                }
                Iterator<String> keys = o.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    Double v = findPower(o.opt(k));
                    if (v != null) return v;
                }
            } else if (value instanceof JSONArray) {
                JSONArray a = (JSONArray) value;
                for (int i = 0; i < a.length(); i++) {
                    Double v = findPower(a.opt(i));
                    if (v != null) return v;
                }
            }
            return null;
        }

        private String http(String method, String endpoint, String body) throws Exception {
            HttpURLConnection c = (HttpURLConnection) new URL(endpoint).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Accept", "application/json");
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int code = c.getResponseCode();
            InputStream stream = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
            String text = read(stream);
            c.disconnect();
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code + (text.isEmpty() ? "" : ": " + text));
            return text;
        }

        private String read(InputStream in) throws Exception {
            if (in == null) return "";
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        }

        private double round(double value) {
            return Math.round(value * 1000.0) / 1000.0;
        }
    }
}
