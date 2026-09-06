---
title: Tafrigh API
emoji: 🎙️
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# سيرفر التفريغ الكامل (Docker)

النسخة دي بتنزّل الصوت وتفرّغه بـ Whisper — فبتشتغل مع كل المنصات ومع الفيديوهات
اللي مالهاش ترجمة جاهزة.

محتاجة سيرفر فيه رام ومعالج — مش زي الـ Worker الخفيف.

```
GET /health
GET /transcribe?url=LINK&lang=ar&model=small&force=0
```

| الباراميتر | الوظيفة |
|---|---|
| `url` | لينك الفيديو (مطلوب) |
| `lang` | `auto` أو `ar` / `en` / `es` / `tr` |
| `model` | `tiny` / `base` / `small` / `medium` / `large-v3` |
| `force` | `1` يتجاهل الترجمة الجاهزة ويفرّغ بـ Whisper |

## فين أنشرها

- **سيرفرك أو VPS** — `docker build -t tafrigh . && docker run -p 7860:7860 tafrigh`
- **[Render](https://render.com)** — فيه خطة مجانية بـ 512 ميجا رام؛ استخدم `tiny` أو `base` بس
- **Hugging Face Spaces** — بقى محتاج اشتراك PRO للـ Docker Spaces

## لو يوتيوب رفض الطلب

السيرفرات السحابية أحيانًا يوتيوب بيحجبها. الحل: صدّر كوكيز حسابك من المتصفح
(إضافة «Get cookies.txt») وحطّ محتوى الملف في متغيّر بيئة اسمه `YT_COOKIES`.
