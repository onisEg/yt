/**
 * Tafrigh Worker — سيرفر تفريغ خفيف على Cloudflare Workers.
 *
 * بيجيب الترجمة الجاهزة (المرفوعة أو التلقائية) من يوتيوب ويرجّعها نص نضيف.
 * مجاني بالكامل، مفيش سيرفر ولا دوكر ولا كارت.
 *
 *   GET /health
 *   GET /transcribe?url=LINK&lang=ar
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

/**
 * ترتيب العملاء مهم: ANDROID_VR هو الوحيد اللي لسه بيرجّع ترجمات
 * من غير تسجيل دخول في معظم الحالات.
 */
const CLIENTS = [
  {
    name: "ANDROID_VR",
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
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.master.0-qa (unlike Gecko) Starboard/16",
    context: { clientName: "TVHTML5", clientVersion: "7.20250101.10.00", hl: "en", gl: "US" },
  },
  {
    name: "WEB",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    context: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
  },
];

/* ---------------------------------------------------------------- helpers */

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

/** الـ baseUrl بتاع يوتيوب فيه fmt=srv3 أصلًا — لازم نستبدله مش نزود عليه. */
function asJson3(baseUrl) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", "json3");
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function tracksOf(player) {
  return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
}

async function fromInnertube(id) {
  const reasons = [];
  for (const c of CLIENTS) {
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": c.ua,
            "accept-language": "en-US,en;q=0.9",
            origin: "https://www.youtube.com",
          },
          body: JSON.stringify({
            videoId: id,
            context: { client: c.context },
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
      reasons.push(
        `${c.name}:${data?.playabilityStatus?.status || "NO_CAPTIONS"}`
      );
    } catch (e) {
      reasons.push(`${c.name}:${e.message}`);
    }
  }
  return { reasons };
}

/** خطة بديلة: نقرأ صفحة الفيديو نفسها. */
async function fromWatchPage(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) return { reasons: [`watch:HTTP${res.status}`] };
  const html = await res.text();

  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return { reasons: ["watch:NO_CAPTIONS"] };

  let tracks;
  try {
    tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
  } catch {
    return { reasons: ["watch:PARSE_FAILED"] };
  }

  const t = html.match(/"title":\s*"([^"]{1,200})"/);
  const d = html.match(/"lengthSeconds":\s*"(\d+)"/);
  return {
    tracks,
    details: { title: t ? t[1] : "video", lengthSeconds: d ? d[1] : "0" },
    via: "watch",
  };
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

function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

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

async function trackText(track) {
  const res = await fetch(asJson3(track.baseUrl), {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`مقدرتش أجيب ملف الترجمة (${res.status}).`);

  const body = await res.text();
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
    // srv3/srv1 — الأسطر بتيجي في <p> أو <text>
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

/* ----------------------------------------------------------------- routes */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS });

    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/")
      return new Response(
        "<html dir='rtl'><body style='font-family:sans-serif;padding:40px;line-height:2'>" +
          "<h2>سيرفر التفريغ شغّال ✅</h2>" +
          "<p><code>/transcribe?url=LINK&amp;lang=ar</code></p></body></html>",
        { headers: { "content-type": "text/html;charset=utf-8", ...CORS } }
      );

    if (url.pathname !== "/transcribe")
      return json({ detail: "المسار مش موجود." }, 404);

    const started = Date.now();
    const target = url.searchParams.get("url") || "";
    const lang = url.searchParams.get("lang") || "auto";

    const id = videoId(target);
    if (!id)
      return json(
        { detail: "النسخة دي بتشتغل مع يوتيوب بس. للمنصات التانية استخدم تاب «ملف من جهازك»." },
        400
      );

    let found = await fromInnertube(id);
    if (!found.tracks) {
      const fallback = await fromWatchPage(id);
      if (fallback.tracks) found = fallback;
      else found.reasons = [...(found.reasons || []), ...(fallback.reasons || [])];
    }

    if (!found.tracks)
      return json(
        {
          detail:
            "ملقيتش ترجمة جاهزة للفيديو ده — يا مالوش ترجمة أصلًا يا يوتيوب رفض الطلب. " +
            "جرّب تاب «ملف من جهازك» أو نسخة Colab.",
          debug: (found.reasons || []).join(" | "),
        },
        422
      );

    const track = pickTrack(found.tracks, lang);
    let text;
    try {
      text = await trackText(track);
    } catch (e) {
      return json({ detail: e.message }, 502);
    }
    if (!text) return json({ detail: "ملف الترجمة طلع فاضي." }, 422);

    const label =
      track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode;

    return json({
      title: found.details.title || "video",
      text,
      source: `ترجمة يوتيوب — ${label}${track.kind === "asr" ? " (تلقائية)" : ""}`,
      words: text.split(/\s+/).length,
      duration: Number(found.details.lengthSeconds || 0),
      took: Math.round((Date.now() - started) / 100) / 10,
      via: found.via,
    });
  },
};
