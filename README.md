# Ma3loma Studio

استوديو بسيط على جهازك لتوليد الصور والفيديو بـ **Higgsfield API** — مفتاح واحد لكل الموديلات، وبتدفع على كل توليد بس. من غير اشتراك.

## فيه إيه
- **ولّد:** صور وفيديو من ٨ طرق — Soul 2 · Marketing Studio Image · Kling 3.0 · MiniMax H3 · Seedance 2.5 (من نص ومن صورة). **السعر مكتوب على الزرار قبل ما تدوس.**
- **المكتبة:** كل اللي اتولّد بينزل على جهازك أول ما يخلص — لأن لينكات Higgsfield بتعيش ٧ أيام بس. وزرار «حرّكها» بيحوّل الصورة لفيديو.
- **الفاتورة:** صرفت كام النهارده وفي الشهر، ولكل موديل، ولكل مشروع. الطلب اللي بيفشل = $0.
- **الإعدادات:** المفتاح بيتحفظ على جهازك بس، وفيه سقف صرف يومي.

## التشغيل
1. سطّب **Node.js 18 أو أحدث**
   - ويندوز: `winget install OpenJS.NodeJS.LTS`
   - ماك: `brew install node`
2. نزّل المشروع: زرار **Code ← Download ZIP** فوق، وفكّه.
3. شغّله:
   - **ويندوز:** دوس مرتين على **`Start Studio.cmd`** — الموقع بيفتح في المتصفح لوحده.
     سيب الشباك الأسود مفتوح طول ما انت شغال، ولما تخلص اقفله.
     لو ويندوز قالك «Windows protected your PC» أو سألك تشغّله: دوس **More info ← Run anyway** (أو **تشغيل**) — ده عشان الملف متنزّل من النت.
   - **ماك أو لينكس:** افتح ترمينال في الفولدر واكتب `npm start`، وافتح `http://127.0.0.1:4545`.
4. **الإعدادات** ← الصق Key ID و Key Secret ← «اختبر الاتصال».

> **ليه مش `start-studio.ps1`؟** ويندوز بيقفل تشغيل سكربتات PowerShell في الوضع العادي، فالملف ده ممكن ميشتغلش بدوسة مرتين. `Start Studio.cmd` مالوش المشكلة دي.

**مفيش `npm install`** — المشروع من غير أي مكتبات خارجية.

## المفتاح منين؟
من الكونسول: **console.higgsfield.ai ← API keys ← Create**.
مش عندك حساب؟ [سجّل في Higgsfield API من هنا](https://higgsfield.ai/s/higgsfield-api-yt-ma3lomatech-IIyzvX).

> **متلصقش المفتاح في أي شات ولا ترفعه على أي حتة.** دخّله من صفحة الإعدادات بس.

## الأمان
- السيرفر شغال على `127.0.0.1` بس — محدش على الشبكة يقدر يوصله.
- المفتاح في ملف `.env` على جهازك، عمره ما بيوصل للمتصفح، ومش بيترفع مع المشروع (`.gitignore`).
- السيرفر بيرفض أي طلب جاي من موقع تاني — عشان محدش يصرف رصيدك من ورا ضهرك.
- سقف صرف يومي وحد للطلبات المتزامنة — من الإعدادات.

## الحدود — بصراحة
- ده استوديو لشخص واحد على جهازه، **مش موقع لناس كتير**: مفيش حسابات ولا باسورد.
- التكلفة في الفاتورة هي تقدير Higgsfield قبل التوليد. الرقم الرسمي في Analytics في الكونسول.
- فيه ٨ طرق توليد بس — والباقي تضيفه بنفسك (تحت).

## إضافة موديل
كل موديل entry في `models.json`: الـendpoint، ونوعه، والحقول المسموحة وقيمها. خدهم من صفحة الموديل في [docs.higgsfield.ai](https://docs.higgsfield.ai/docs/llms.txt) (جزء Complete JSON schema). الواجهة بتبني الفورم لوحدها.

## أدوات جنب الموقع
- `tools/set-hf-key.ps1` — بيحفظ المفتاح في متغير بيئة (ويندوز).
- `tools/first-call.ps1` — أول طلب من الترمينال: بيوريك الطلب والرد والسعر.

---

## English
A local, single-user AI image and video studio on the **Higgsfield API**. Zero dependencies — just Node.js 18+.
`npm start`, open `http://127.0.0.1:4545`, and paste your API key in Settings. The key stays in a local `.env` file and never reaches the browser. Every output is downloaded to `outputs/`, and every request is logged with its cost.

---
معمول بإيد محمد — [معلومة تك](https://www.youtube.com/@ma3lomatech) · [تيليجرام](https://t.me/Ma3lomaTech) · رخصة MIT
