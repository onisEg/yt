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

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

const CLIENTS = [
  {
    name: "ANDROID",
    ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip",
    context: {
      clientName: "ANDROID",
      clientVersion: "19.09.37",
      androidSdkVersion: 30,
      hl: "en",
      gl: "US",
    },
  },
  {
    name: "IOS",
    ua: "com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)",
    context: {
      clientName: "IOS",
      clientVersion: "19.09.3",
      deviceModel: "iPhone14,3",
      hl: "en",
      gl: "US",
    },
  },
  {
    name: "WEB",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    context: {
      clientName: "WEB",
      clientVersion: "2.20240401.00.00",
      hl: "en",
      gl: "US",
    },
  },
];

/* ---------------------------------------------------------------- helpers */

function videoId(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return /^[\w-]{11}$/.test(raw.trim()) ? raw.trim() : null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (!host.endsWith("youtube.com")) return null;
  if (u.searchParams.get("v")) return u.searchParams.get("v");
  const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[2] : null;
}

async function getPlayer(id) {
  let lastReason = "";
  for (const c of CLIENTS) {
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": c.ua,
            "accept-language": "en-US,en;q=0.9",
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
        lastReason = `${c.name}: HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      const tracks =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length) return data;
      lastReason =
        data?.playabilityStatus?.reason ||
        `${c.name}: مفيش ترجمة`;
    } catch (e) {
      lastReason = `${c.name}: ${e.message}`;
    }
  }
  return { __error: lastReason };
}

function pickTrack(tracks, lang) {
  const code = (t) => (t.languageCode || "").toLowerCase();
  const isAuto = (t) => t.kind === "asr";

  if (lang && lang !== "auto") {
    const want = lang.toLowerCase();
    return (
      tracks.find((t) => code(t) === want && !isAuto(t)) ||
      tracks.find((t) => code(t).startsWith(want) && !isAuto(t)) ||
      tracks.find((t) => code(t).startsWith(want)) ||
      tracks.find((t) => !isAuto(t)) ||
      tracks[0]
    );
  }
  return tracks.find((t) => !isAuto(t)) || tracks[0];
}

async function trackText(track) {
  const url = track.baseUrl.includes("fmt=")
    ? track.baseUrl
    : track.baseUrl + "&fmt=json3";

  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`مقدرتش أجيب ملف الترجمة (${res.status}).`);

  const body = await res.text();
  let parts = [];

  try {
    const data = JSON.parse(body);
    for (const ev of data.events || []) {
      const line = (ev.segs || [])
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (line) parts.push(line);
    }
  } catch {
    // XML fallback
    const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(body))) {
      const line = m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) parts.push(line);
    }
  }

  // شيل التكرار بتاع الترجمة التلقائية
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
        {
          detail:
            "النسخة دي بتشتغل مع يوتيوب بس. للمنصات التانية استخدم تاب «ملف من جهازك».",
        },
        400
      );

    const player = await getPlayer(id);
    if (player.__error)
      return json(
        {
          detail:
            "ملقيتش ترجمة للفيديو ده. جرّب تاب «ملف من جهازك» أو نسخة الـ Colab. (" +
            player.__error +
            ")",
        },
        422
      );

    const details = player.videoDetails || {};
    const tracks =
      player.captions.playerCaptionsTracklistRenderer.captionTracks;
    const track = pickTrack(tracks, lang);

    let text;
    try {
      text = await trackText(track);
    } catch (e) {
      return json({ detail: e.message }, 502);
    }

    if (!text)
      return json({ detail: "ملف الترجمة طلع فاضي." }, 422);

    const label =
      track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode;

    return json({
      title: details.title || "video",
      text,
      source: `ترجمة يوتيوب — ${label}${track.kind === "asr" ? " (تلقائية)" : ""}`,
      words: text.split(/\s+/).length,
      duration: Number(details.lengthSeconds || 0),
      took: Math.round((Date.now() - started) / 100) / 10,
    });
  },
};
