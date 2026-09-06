# 🎙️ تفريغ — Tafrigh

حط لينك أي فيديو، استلم كلامه نص.

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/onisEg/yt/blob/main/tafrigh_colab.ipynb)

---

## الطرق الأربعة

| | الاستخدام | بيشتغل مع |
|---|---|---|
| **الصفحة + Worker** | لينك ← نص في ثواني | يوتيوب اللي عنده ترجمة |
| **الصفحة — تاب الملف** | ترفع ملف ← تفريغ جوه المتصفح | أي ملف صوت أو فيديو |
| **Colab** | لينك ← Whisper على GPU مجاني | كل المنصات، ولو مفيش ترجمة |
| **سطر الأوامر** | `python tafrigh.py "LINK"` | كل حاجة، بأعلى دقة |

---

## ١) الصفحة — لينك وخلاص

الصفحة (`index.html`) منشورة على GitHub Pages. محتاجة توصيلة مرة واحدة بـ Cloudflare Worker
مجاني — الخطوات في [`worker/README.md`](worker/README.md).

ليه محتاجين وركر؟ لأن المتصفح ممنوع أمنيًا (CORS) إنه يكلّم يوتيوب مباشرة.

## ٢) تاب «ملف من جهازك»

مفيش سيرفر خالص — Whisper بيشتغل جوه المتصفح عبر Transformers.js.
الملف مش بيطلع من جهازك.

## ٣) Colab

دوس البادج فوق. `Runtime` ← `Change runtime type` ← **T4 GPU**، شغّل خانة التجهيز،
حط اللينك ودوس ▶. دي أدق طريقة للعربي.

## ٤) على جهازك

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

المخرجات في `transcripts/`.

| الخيار | الوظيفة |
|---|---|
| `--lang, -l` | لغة الفيديو (`ar` / `en` / `es` / `tr`) |
| `--whisper, -w` | تجاهل الترجمة الجاهزة |
| `--model, -m` | `tiny` / `base` / `small` / `medium` / `large-v3` |
| `--srt` | يطلّع كمان ملف `.srt` |
| `--out, -o` | فولدر المخرجات |

**ملاحظة عن العربي:** `small` كويس للإنجليزي، لكن للعربي — وخصوصًا اللهجات —
`medium` أو `large-v3` بيفرقوا كتير.

---

## الملفات

```
index.html              الصفحة (GitHub Pages)
tafrigh.py              أداة سطر الأوامر
tafrigh_colab.ipynb     نوتبوك Colab
worker/worker.js        سيرفر Cloudflare المجاني
server/                 نسخة Docker كاملة (Whisper + كل المنصات)
```

## الترخيص

MIT
