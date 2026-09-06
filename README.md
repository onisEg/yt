# 🎙️ تفريغ — Tafrigh

حط لينك أي فيديو، استلم كلامه نص.

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/onisEg/yt/blob/main/tafrigh_colab.ipynb)

شغّالة مع يوتيوب، تيك توك، فيسبوك، إنستجرام، تويتر، وأي منصة `yt-dlp` بيدعمها.

---

## إزاي بتشتغل

على مرحلتين:

1. **الترجمة الجاهزة** — بتدوّر الأول على الـ subtitles المرفوعة أو الأوتوماتيك بتاعة الفيديو. ثواني وببلاش.
2. **Whisper** — لو الفيديو مالوش ترجمة، بتنزّل الصوت وتفرّغه محليًا. من غير API key، ومن غير ما يترفع أي حاجة لحد.

---

## ٣ طرق للاستخدام

### ١) Colab — من غير أي تنصيب

ادوس على الزرار الأزرق فوق. اختار `Runtime` ← `Change runtime type` ← **T4 GPU**، شغّل خانة التجهيز، بعدين حط اللينك ودوس ▶. الملف بينزّل على جهازك أوتوماتيك.

### ٢) GitHub Actions — من المتصفح أو الموبايل

تاب **Actions** ← `تفريغ فيديو` ← `Run workflow` ← الصق اللينك.
النص بيظهر في الـ Summary وبيتحفظ كـ artifact تقدر تنزّله.

> على السيرفر بتاع GitHub الـ CPU بس، فلو الفيديو مالوش ترجمة جاهزة وطويل — استخدم Colab أحسن.

### ٣) على جهازك

```bash
git clone https://github.com/onisEg/yt.git
cd yt
pip install -r requirements.txt
brew install ffmpeg          # أو: sudo apt install ffmpeg
```

```bash
python tafrigh.py "https://www.youtube.com/watch?v=..."
python tafrigh.py "LINK" --lang ar --srt
python tafrigh.py "LINK" --whisper --model medium
python tafrigh.py                              # هيسألك على اللينك
```

المخرجات بتتحفظ في `transcripts/`.

---

## الخيارات

| الخيار | الوظيفة |
|---|---|
| `--lang, -l` | لغة الفيديو (`ar` / `en` / `es` / `tr`). سيبها فاضية للاكتشاف الأوتوماتيك |
| `--whisper, -w` | تجاهل الترجمة الجاهزة وفرّغ بـ Whisper على طول |
| `--model, -m` | حجم الموديل: `tiny` / `base` / `small` / `medium` / `large-v3` |
| `--srt` | يطلّع كمان ملف ترجمة `.srt` |
| `--out, -o` | فولدر المخرجات |

**ملاحظة عن العربي:** `small` كويس للإنجليزي، لكن للعربي — وخصوصًا اللهجات — `medium` أو `large-v3` بيفرقوا كتير في الدقة. أبطأ، بس النتيجة مختلفة تمامًا.

---

## المتطلبات

- Python 3.9+
- ffmpeg
- `yt-dlp` + `faster-whisper`

## الترخيص

MIT
