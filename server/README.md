---
title: Tafrigh API
emoji: 🎙️
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# سيرفر التفريغ

ياخد لينك فيديو ويرجّع النص.

```
GET /transcribe?url=LINK&lang=ar&model=small
```

| الباراميتر | الوظيفة |
|---|---|
| `url` | لينك الفيديو (مطلوب) |
| `lang` | `auto` أو `ar` / `en` / `es` / `tr` |
| `model` | `tiny` / `base` / `small` / `medium` / `large-v3` |
| `force` | `1` عشان يتجاهل الترجمة الجاهزة ويفرّغ بـ Whisper |

## لو يوتيوب رفض الطلب

السيرفرات السحابية أحيانًا يوتيوب بيحجبها. الحل: صدّر كوكيز حسابك من المتصفح
(إضافة «Get cookies.txt») وحطّ محتوى الملف في متغيّر سرّي اسمه `YT_COOKIES`
من `Settings ← Variables and secrets`.

## نشر

المجلد ده جاهز للرفع على Hugging Face Space من نوع Docker.
الملفات المطلوبة: `Dockerfile` و`requirements.txt` و`app.py` و`README.md`.
