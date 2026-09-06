/**
 * Tafrigh Worker — سيرفر تفريغ خفيف على Cloudflare Workers.
 *
 *   GET /health      حالة السيرفر + تشخيص الكوكيز
 *   GET /transcribe?url=LINK&lang=ar
 *
 * ⚠️ يوتيوب بيحجب عناوين السيرفرات. الحل: متغيّر سرّي YT_COOKIES
 * بالشكل ده بالظبط:  NAME=VALUE; NAME2=VALUE2
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", ...CORS },
  });

const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const UA_WEB =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * auth: true يعني العميل ده بيقبل الكوكيز والتوقيع.
 * عملاء الأندرويد/التلفزيون بيرفضوا الطلبات الموقّعة (403) فبنبعتهم من غير كوكيز.
 */
const CLIENTS = [
  {
    name: "WEB",
    auth: true,
    ua: UA_WEB,
    context: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
  },
  {
    name: "MWEB",
    auth: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    context: { clientName: "MWEB", clientVersion: "2.20250101.01.00", hl: "en", gl: "US" },
  },
  {
    name: "ANDROID_VR",
    auth: false,
    ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L) gzip",
    context: {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      hl: "en",
      gl: "US",
    },
  },
  {
    name: "TVHTML5",
    auth: false,
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.master.0-qa (unlike Gecko) Starboard/16",
    context: { clientName: "TVHTML5", clientVersion: "7.20250101.10.00", hl: "en", gl: "US" },
  },
];

/* ------------------------------------------------------------------ auth */

function cookieValue(cookies, name) {
  const m = (cookies || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function cookieReport(raw) {
  const cookies = (raw || "").trim();
  if (!cookies) return { present: false };
  const names = [...cookies.matchAll(/(?:^|;\s*)([^=;\s]+)=/g)].map((m) => m[1]);
  const need = ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-3PAPISID"];
  return {
    present: true,
    count: names.length,
    hasSapisid: Boolean(
      cookieValue(cookies, "SAPISID") ||
        cookieValue(cookies, "__Secure-3PAPISID") ||
        cookieValue(cookies, "__Secure-1PAPISID")
    ),
    missing: need.filter((n) => !cookieValue(cookies, n)),
    // لو الصيغة غلط (لصقت ملف Netscape زي ما هو) هيبان هنا
    looksWrong: cookies.includes("\t") || cookies.startsWith("# "),
  };
}

/** يوتيوب بيطلب توقيع SAPISIDHASH مع الكوكيز عشان يقبل الطلب. */
async function authHeaders(raw) {
  const cookies = (raw || "").trim();
  if (!cookies) return {};
  const sapisid =
    cookieValue(cookies, "SAPISID") ||
    cookieValue(cookies, "__Secure-3PAPISID") ||
    cookieValue(cookies, "__Secure-1PAPISID");

  const headers = { cookie: cookies };
  if (!sapisid) return headers;

  const origin = "https://www.youtube.com";
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${ts} ${sapisid} ${origin}`)
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  headers.authorization = `SAPISIDHASH ${ts}_${hex}`;
  headers["x-origin"] = origin;
  headers["x-goog-authuser"] = "0";
  return headers;
}

/* --------------------------------------------------------------- helpers */

function videoId(raw) {
  const s = (raw || "").trim();
  let u;
  try {
    u = new URL(s);
  } catch {
    return /^[\w-]{11}$/.test(s) ? s : null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (!host.endsWith("youtube.com")) return null;
  if (u.searchParams.get("v")) return u.searchParams.get("v");
  const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[2] : null;
}

/** الـ baseUrl فيه fmt=srv3 أصلًا — لازم نستبدله مش نزوّد عليه. */
function withFmt(baseUrl, fmt) {
  try {
    const u = new URL(baseUrl);
    if (fmt) u.searchParams.set("fmt", fmt);
    else u.searchParams.delete("fmt");
    return u.toString();
  } catch {
    return baseUrl;
  }
}

const tracksOf = (p) =>
  p?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;

async function visitorData(auth) {
  try {
    const res = await fetch("https://www.youtube.com/sw.js_data", {
      headers: { "user-agent": UA_WEB, ...auth },
    });
    if (!res.ok) return null;
    const txt = await res.text();
    const m = txt.match(/"(Cg[A-Za-z0-9_\-%]{40,})"/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

async function fromInnertube(id, auth, visitor) {
  const reasons = [];
  for (const c of CLIENTS) {
    try {
      const context = { ...c.context };
      if (visitor) context.visitorData = visitor;

      const headers = {
        "content-type": "application/json",
        "user-agent": c.ua,
        "accept-language": "en-US,en;q=0.9",
        origin: "https://www.youtube.com",
        referer: "https://www.youtube.com/",
      };
      if (c.auth) Object.assign(headers, auth);
      if (visitor) headers["x-goog-visitor-id"] = visitor;

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            videoId: id,
            context: { client: context },
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        }
      );
      if (!res.ok) {
        reasons.push(`${c.name}:HTTP${res.status}`);
        continue;
      }
      const data = await res.json();
      const tracks = tracksOf(data);
      if (tracks?.length)
        return { tracks, details: data.videoDetails || {}, via: c.name };
      reasons.push(`${c.name}:${data?.playabilityStatus?.status || "NO_CAPTIONS"}`);
    } catch (e) {
      reasons.push(`${c.name}:${e.message}`);
    }
  }
  return { reasons };
}

async function fromWatchPage(id, auth) {
  try {
    const headers = {
      "user-agent": UA_WEB,
      "accept-language": "en-US,en;q=0.9",
      cookie: "CONSENT=YES+cb; SOCS=CAI",
      ...auth,
    };
    const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers });
    if (!res.ok) return { reasons: [`watch:HTTP${res.status}`] };
    const html = await res.text();

    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) {
      const walled = /confirm you|not a bot|sign in to confirm/i.test(html);
      return { reasons: [walled ? "watch:BOT_WALL" : "watch:NO_CAPTIONS"] };
    }

    const tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
    const t = html.match(/"title":\s*"([^"]{1,200})"/);
    const d = html.match(/"lengthSeconds":\s*"(\d+)"/);
    return {
      tracks,
      details: { title: t ? t[1] : "video", lengthSeconds: d ? d[1] : "0" },
      via: "watch",
    };
  } catch (e) {
    return { reasons: [`watch:${e.message}`] };
  }
}

function pickTrack(tracks, lang) {
  const code = (t) => (t.languageCode || "").toLowerCase();
  const auto = (t) => t.kind === "asr";
  if (lang && lang !== "auto") {
    const want = lang.toLowerCase();
    return (
      tracks.find((t) => code(t) === want && !auto(t)) ||
      tracks.find((t) => code(t).startsWith(want) && !auto(t)) ||
      tracks.find((t) => code(t).startsWith(want)) ||
      tracks.find((t) => !auto(t)) ||
      tracks[0]
    );
  }
  return tracks.find((t) => !auto(t)) || tracks[0];
}

const unescapeHtml = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

function tidy(parts) {
  const lines = [];
  for (const p of parts) {
    const prev = lines[lines.length - 1];
    if (prev === undefined) { lines.push(p); continue; }
    if (p === prev) continue;
    if (p.startsWith(prev)) { lines[lines.length - 1] = p; continue; }
    if (prev.endsWith(p)) continue;
    lines.push(p);
  }
  return lines
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/(?<=[.!?؟。])\s+/g, "\n")
    .trim();
}

function parseCaptions(body) {
  const parts = [];
  if (body.trim().startsWith("{")) {
    const data = JSON.parse(body);
    for (const ev of data.events || []) {
      const line = (ev.segs || [])
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (line) parts.push(line);
    }
  } else {
    const re = /<(?:p|text)\b[^>]*>([\s\S]*?)<\/(?:p|text)>/g;
    let m;
    while ((m = re.exec(body))) {
      const line = unescapeHtml(m[1].replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
      if (line) parts.push(line);
    }
  }
  return tidy(parts);
}

/** بنجرّب أكتر من صيغة — أحيانًا json3 بيرجّع فاضي والـ srv3 بيشتغل. */
async function trackText(track, auth) {
  const headers = { "user-agent": UA_WEB, "accept-language": "en-US,en;q=0.9", ...auth };
  let lastStatus = 0;
  for (const fmt of ["json3", "srv3", null]) {
    try {
      const res = await fetch(withFmt(track.baseUrl, fmt), { headers });
      lastStatus = res.status;
      if (!res.ok) continue;
      const body = await res.text();
      if (!body.trim()) continue;
      const text = parseCaptions(body);
      if (text) return text;
    } catch {
      /* نكمّل على الصيغة اللي بعدها */
    }
  }
  throw new Error(`ملف الترجمة رجع فاضي (HTTP ${lastStatus}).`);
}

/* ----------------------------------------------------------------- routes */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });

    if (url.pathname === "/health")
      return json({ ok: true, version: 4, cookies: cookieReport(env?.YT_COOKIES) });

    if (url.pathname === "/")
      return new Response(
        "<html dir='rtl'><body style='font-family:sans-serif;padding:40px;line-height:2'>" +
          "<h2>سيرفر التفريغ شغّال ✅</h2>" +
          "<p><code>/transcribe?url=LINK&amp;lang=ar</code></p>" +
          "<p><code>/health</code> للتشخيص</p></body></html>",
        { headers: { "content-type": "text/html;charset=utf-8", ...CORS } }
      );

    if (url.pathname !== "/transcribe")
      return json({ detail: "المسار مش موجود." }, 404);

    const started = Date.now();
    const target = url.searchParams.get("url") || "";
    const lang = url.searchParams.get("lang") || "auto";
    const fresh = url.searchParams.get("fresh") === "1";

    const id = videoId(target);
    if (!id)
      return json(
        { detail: "النسخة دي بتشتغل مع يوتيوب بس. للمنصات التانية استخدم تاب «ملف من جهازك»." },
        400
      );

    const cache = caches.default;
    const cacheKey = new Request(`https://tafrigh.cache/${id}/${lang}`);
    if (!fresh) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    const auth = await authHeaders(env?.YT_COOKIES);
    const visitor = await visitorData(auth);

    let found = await fromInnertube(id, auth, visitor);
    if (!found.tracks) {
      const fallback = await fromWatchPage(id, auth);
      if (fallback.tracks) found = fallback;
      else found.reasons = [...(found.reasons || []), ...(fallback.reasons || [])];
    }

    if (!found.tracks) {
      const why = (found.reasons || []).join(" ");
      const blocked = why.includes("LOGIN_REQUIRED") || why.includes("BOT_WALL");
      const report = cookieReport(env?.YT_COOKIES);
      return json(
        {
          detail: blocked
            ? report.present
              ? "يوتيوب لسه رافض الطلب رغم الكوكيز — غالبًا الكوكيز منتهية أو ناقصة. شوف /health."
              : "يوتيوب رفض الطلب من السيرفر. محتاج تضيف كوكيز في متغيّر YT_COOKIES."
            : "ملقيتش ترجمة جاهزة للفيديو ده. جرّب تاب «ملف من جهازك» أو نسخة Colab.",
          debug: (found.reasons || []).join(" | "),
          cookies: report,
        },
        422
      );
    }

    const track = pickTrack(found.tracks, lang);
    let text;
    try {
      text = await trackText(track, auth);
    } catch (e) {
      return json({ detail: e.message }, 502);
    }

    const label =
      track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode;

    const payload = {
      title: found.details.title || "video",
      text,
      source: `ترجمة يوتيوب — ${label}${track.kind === "asr" ? " (تلقائية)" : ""}`,
      words: text.split(/\s+/).length,
      duration: Number(found.details.lengthSeconds || 0),
      took: Math.round((Date.now() - started) / 100) / 10,
      via: found.via,
    };

    const response = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json;charset=utf-8",
        "cache-control": "public, max-age=86400",
        ...CORS,
      },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  },
};
