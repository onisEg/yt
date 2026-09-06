#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tafrigh.py — أداة تفريغ الفيديوهات

بتاخد لينك فيديو (يوتيوب / تيك توك / فيسبوك / إنستجرام / تويتر ... أي حاجة yt-dlp بيدعمها)
وترجّع لك كلام الفيديو كنص.

بتشتغل على خطوتين:
  1) بتدوّر الأول على الترجمة الجاهزة (subtitles) المرفوعة أو الأوتوماتيك — دي أسرع حاجة، ثواني.
  2) لو مفيش، بتنزّل الصوت وتفرّغه محليًا بـ Whisper (من غير API key).

التنصيب:
    pip install -U yt-dlp faster-whisper
    # ولازم ffmpeg يكون متسطّب:
    #   Mac:     brew install ffmpeg
    #   Ubuntu:  sudo apt install ffmpeg
    #   Windows: winget install ffmpeg

الاستخدام:
    python tafrigh.py "https://www.youtube.com/watch?v=..."
    python tafrigh.py "LINK" --lang ar
    python tafrigh.py "LINK" --whisper --model small --srt
    python tafrigh.py                # من غير باراميترات، هيسألك على اللينك

المخرجات بتتحفظ في فولدر transcripts/
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

OUT_DIR = Path("transcripts")
DEFAULT_SUB_LANGS = "ar.*,en.*,es.*,tr.*"


# ---------------------------------------------------------------- أدوات مساعدة

def die(msg: str) -> None:
    print(f"\n❌ {msg}\n", file=sys.stderr)
    sys.exit(1)


def log(msg: str) -> None:
    print(f"→ {msg}", flush=True)


def need(tool: str, hint: str) -> None:
    if shutil.which(tool) is None:
        die(f"'{tool}' مش متسطّب.\n   {hint}")


def run(cmd: list, quiet: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE if quiet else None,
        stderr=subprocess.PIPE if quiet else None,
        text=True,
    )


def safe_name(name: str, limit: int = 80) -> str:
    name = re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return (name[:limit].strip() or "video")


def video_title(url: str) -> str:
    r = run(["yt-dlp", "--no-warnings", "--print", "%(title)s", "--skip-download", url])
    title = (r.stdout or "").strip().splitlines()
    return safe_name(title[0]) if title else "video"


# ------------------------------------------------------- الطريقة ١: الترجمة الجاهزة

def fetch_subtitles(url: str, langs: str, workdir: Path):
    """بيحاول ينزّل ملف ترجمة VTT. بيرجّع مسار الملف أو None."""
    cmd = [
        "yt-dlp", "--no-warnings", "--skip-download",
        "--write-subs", "--write-auto-subs",
        "--sub-langs", langs,
        "--sub-format", "vtt/best",
        "--convert-subs", "vtt",
        "-o", str(workdir / "%(id)s.%(ext)s"),
        url,
    ]
    run(cmd)
    files = sorted(workdir.glob("*.vtt"), key=lambda p: p.stat().st_size, reverse=True)
    return files[0] if files else None


def vtt_to_text(vtt_path: Path) -> str:
    """بينضّف ملف VTT ويطلّع نص نضيف، مع التخلّص من التكرار بتاع الترجمة الأوتوماتيك."""
    raw = vtt_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    lines = []

    for line in raw:
        line = line.strip()
        if not line:
            continue
        if line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE", "REGION")):
            continue
        if "-->" in line or re.fullmatch(r"\d+", line):
            continue

        line = re.sub(r"<[^>]+>", "", line)          # تاجات التوقيت جوه السطر
        line = re.sub(r"&nbsp;?", " ", line)
        line = re.sub(r"&amp;", "&", line)
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue

        # الترجمة الأوتوماتيك بتعيد السطر السابق وتزوّد عليه — بناخد الأطول ونرمي التكرار
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

    text = " ".join(lines)
    text = re.sub(r"\s+", " ", text).strip()
    # تقسيم فقرات على علامات الوقف عشان يبقى مقروء
    text = re.sub(r"(?<=[.!?؟。])\s+", "\n", text)
    return text


# ----------------------------------------------------------- الطريقة ٢: Whisper

def download_audio(url: str, workdir: Path) -> Path:
    log("بنزّل الصوت…")
    cmd = [
        "yt-dlp", "--no-warnings",
        "-f", "bestaudio/best",
        "-x", "--audio-format", "mp3", "--audio-quality", "5",
        "-o", str(workdir / "audio.%(ext)s"),
        url,
    ]
    r = run(cmd, quiet=False)
    if r.returncode != 0:
        die("مقدرتش أنزّل الصوت من اللينك ده.")
    files = list(workdir.glob("audio.*"))
    if not files:
        die("التحميل خلص بس ملقتش ملف صوت.")
    return files[0]


def fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def whisper_transcribe(audio: Path, lang, model_size: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        die("faster-whisper مش متسطّب.\n   pip install -U faster-whisper")

    device, compute = "cpu", "int8"
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            device, compute = "cuda", "float16"
    except Exception:
        pass

    log(f"بحمّل موديل Whisper ({model_size}) على {device}… أول مرة بس بياخد وقت في التحميل.")
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute)
    except Exception as e:
        if device == "cuda":
            log(f"الكارت مظبطش ({e}) — هرجع على الـ CPU.")
            model = WhisperModel(model_size, device="cpu", compute_type="int8")
        else:
            raise

    log("بفرّغ الكلام… (ممكن ياخد شوية حسب طول الفيديو)")
    segments, info = model.transcribe(
        str(audio),
        language=lang,
        vad_filter=True,
        beam_size=5,
    )
    log(f"اللغة المكتشفة: {info.language} (ثقة {info.language_probability:.0%})")

    parts, srt = [], []
    for i, seg in enumerate(segments, 1):
        txt = seg.text.strip()
        if not txt:
            continue
        parts.append(txt)
        srt.append(f"{i}\n{fmt_ts(seg.start)} --> {fmt_ts(seg.end)}\n{txt}\n")
        print(f"   [{fmt_ts(seg.start)[:8]}] {txt}", flush=True)

    text = " ".join(parts)
    text = re.sub(r"(?<=[.!?؟。])\s+", "\n", text).strip()
    return text, "\n".join(srt)


# ------------------------------------------------------------------------ main

def main() -> None:
    p = argparse.ArgumentParser(
        description="تفريغ كلام أي فيديو من لينك إلى نص",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("url", nargs="?", help="لينك الفيديو")
    p.add_argument("--lang", "-l", default=None,
                   help="لغة الفيديو (ar / en / es / tr). سيبها فاضية للاكتشاف الأوتوماتيك")
    p.add_argument("--whisper", "-w", action="store_true",
                   help="تجاهل الترجمة الجاهزة وفرّغ بـ Whisper على طول")
    p.add_argument("--model", "-m", default="small",
                   choices=["tiny", "base", "small", "medium", "large-v3"],
                   help="حجم موديل Whisper (الأكبر = أدق وأبطأ). الافتراضي: small")
    p.add_argument("--srt", action="store_true", help="اطلع كمان ملف ترجمة .srt")
    p.add_argument("--out", "-o", default=str(OUT_DIR), help="فولدر المخرجات")
    args = p.parse_args()

    url = args.url or input("الصق لينك الفيديو: ").strip()
    if not url:
        die("مفيش لينك.")

    need("yt-dlp", "pip install -U yt-dlp")
    need("ffmpeg", "Mac: brew install ffmpeg | Ubuntu: sudo apt install ffmpeg")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    log("بجيب بيانات الفيديو…")
    title = video_title(url)
    print(f"   🎬 {title}")

    text, srt_content, source = "", None, ""

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)

        if not args.whisper:
            langs = f"{args.lang}.*" if args.lang else DEFAULT_SUB_LANGS
            log("بدوّر على ترجمة جاهزة…")
            vtt = fetch_subtitles(url, langs, workdir)
            if vtt:
                text = vtt_to_text(vtt)
                source = "الترجمة الجاهزة من المنصة"
                if args.srt:
                    shutil.copy(vtt, out_dir / f"{title}.vtt")
            else:
                log("مفيش ترجمة جاهزة — هنفرّغ بـ Whisper.")

        if not text:
            audio = download_audio(url, workdir)
            text, srt_content = whisper_transcribe(audio, args.lang, args.model)
            source = f"Whisper ({args.model})"

    if not text.strip():
        die("مطلعش أي كلام من الفيديو ده.")

    txt_path = out_dir / f"{title}.txt"
    txt_path.write_text(text, encoding="utf-8")

    if args.srt and srt_content:
        (out_dir / f"{title}.srt").write_text(srt_content, encoding="utf-8")

    words = len(text.split())
    print(f"\n✅ تمّ — المصدر: {source}")
    print(f"   {words} كلمة")
    print(f"   📄 {txt_path.resolve()}\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nاتلغى.")
        sys.exit(130)
