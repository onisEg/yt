#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
سيرفر التفريغ — بياخد لينك فيديو ويرجّع النص.

بيشتغل على Hugging Face Spaces (Docker) أو أي سيرفر عادي.
  GET /transcribe?url=...&lang=ar&model=small&force=0
"""

import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

MAX_MINUTES = int(os.getenv("MAX_MINUTES", "120"))
DEFAULT_SUB_LANGS = "ar.*,en.*,es.*,tr.*,fr.*,de.*"
_models = {}

app = FastAPI(title="Tafrigh API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------ yt-dlp

def _cookies_file():
    """لو حطيت كوكيز يوتيوب في متغيّر YT_COOKIES، بنكتبها في ملف."""
    raw = os.getenv("YT_COOKIES", "").strip()
    if not raw:
        return None
    path = Path("/tmp/cookies.txt")
    if not path.exists():
        path.write_text(raw, encoding="utf-8")
    return str(path)


def ydl(args):
    base = ["yt-dlp", "--no-warnings", "--no-playlist",
            "--extractor-args", "youtube:player_client=android,web"]
    cookies = _cookies_file()
    if cookies:
        base += ["--cookies", cookies]
    return subprocess.run(base + args, capture_output=True, text=True, timeout=900)


def probe(url: str):
    r = ydl(["--print", "%(title)s|||%(duration)s", "--skip-download", url])
    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        msg = err[-1] if err else "مقدرتش أوصل للفيديو."
        if "confirm you" in msg or "bot" in msg.lower():
            msg = "يوتيوب رفض الطلب من السيرفر. ضيف كوكيز في متغيّر YT_COOKIES."
        raise HTTPException(400, msg)
    out = (r.stdout or "").strip().splitlines()[0]
    title, _, dur = out.partition("|||")
    try:
        seconds = int(float(dur))
    except (TypeError, ValueError):
        seconds = 0
    return title.strip() or "video", seconds


# --------------------------------------------------------- ١) الترجمة الجاهزة

def fetch_subtitles(url: str, langs: str, workdir: Path):
    ydl([
        "--skip-download", "--write-subs", "--write-auto-subs",
        "--sub-langs", langs, "--sub-format", "vtt/best", "--convert-subs", "vtt",
        "-o", str(workdir / "%(id)s.%(ext)s"), url,
    ])
    files = sorted(workdir.glob("*.vtt"), key=lambda p: p.stat().st_size, reverse=True)
    return files[0] if files else None


def vtt_to_text(path: Path) -> str:
    lines = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE", "REGION")):
            continue
        if "-->" in line or re.fullmatch(r"\d+", line):
            continue
        line = re.sub(r"<[^>]+>", "", line)
        line = re.sub(r"&nbsp;?", " ", line)
        line = re.sub(r"&amp;", "&", line)
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        if lines:
            prev = lines[-1]
            if line == prev:
                continue
            if line.startswith(prev):
                lines[-1] = line
                continue
            if prev.endswith(line):
                continue
        lines.append(line)
    text = re.sub(r"\s+", " ", " ".join(lines)).strip()
    return re.sub(r"(?<=[.!?؟。])\s+", "\n", text)


# ------------------------------------------------------------- ٢) Whisper

def download_audio(url: str, workdir: Path) -> Path:
    r = ydl([
        "-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "5",
        "-o", str(workdir / "audio.%(ext)s"), url,
    ])
    files = list(workdir.glob("audio.*"))
    if r.returncode != 0 or not files:
        raise HTTPException(400, "مقدرتش أنزّل الصوت من اللينك ده.")
    return files[0]


def get_model(size: str):
    if size not in _models:
        from faster_whisper import WhisperModel
        device, compute = "cpu", "int8"
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device, compute = "cuda", "float16"
        except Exception:
            pass
        _models[size] = WhisperModel(size, device=device, compute_type=compute)
    return _models[size]


def whisper_text(audio: Path, lang, size: str) -> str:
    segments, _ = get_model(size).transcribe(
        str(audio), language=lang, vad_filter=True, beam_size=5
    )
    text = " ".join(s.text.strip() for s in segments if s.text.strip())
    return re.sub(r"(?<=[.!?؟。])\s+", "\n", text).strip()


# ------------------------------------------------------------------ routes

@app.get("/", response_class=HTMLResponse)
def home():
    return (
        "<html dir='rtl'><body style='font-family:sans-serif;padding:40px;line-height:2'>"
        "<h2>سيرفر التفريغ شغّال ✅</h2>"
        "<p>استخدمه من الصفحة بتاعتك، أو جرّب:</p>"
        "<code>/transcribe?url=LINK&lang=ar</code>"
        "</body></html>"
    )


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/transcribe")
def transcribe(
    url: str = Query(..., min_length=8),
    lang: str = Query("auto"),
    model: str = Query("small"),
    force: int = Query(0),
):
    if model not in {"tiny", "base", "small", "medium", "large-v3"}:
        model = "small"
    language = None if lang in ("auto", "") else lang
    started = time.time()

    title, seconds = probe(url)
    if seconds and seconds > MAX_MINUTES * 60:
        raise HTTPException(400, f"الفيديو أطول من {MAX_MINUTES} دقيقة.")

    text, source = "", ""
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)

        if not force:
            langs = f"{lang}.*" if language else DEFAULT_SUB_LANGS
            vtt = fetch_subtitles(url, langs, workdir)
            if vtt:
                text = vtt_to_text(vtt)
                source = "الترجمة الجاهزة من المنصة"

        if not text.strip():
            audio = download_audio(url, workdir)
            text = whisper_text(audio, language, model)
            source = f"Whisper ({model})"

    if not text.strip():
        raise HTTPException(422, "مطلعش أي كلام من الفيديو ده.")

    return {
        "title": title,
        "text": text,
        "source": source,
        "words": len(text.split()),
        "duration": seconds,
        "took": round(time.time() - started, 1),
    }
