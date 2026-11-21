# 🏪 WarungWise — Hybrid AI Assistant for Small Shops

**WarungWise** helps Indonesian *warung* (small shop) and MSME owners turn the
messy text of daily trade — supplier price lists, WhatsApp chats, handwritten
stock notes — into structured data and ready-to-send drafts.

It is built for the **#BuildHybridAI 2026** hackathon. **Every AI call goes
through Firebase AI Logic**, split deliberately between two inference paths:

| Task | Path | Why |
| --- | --- | --- |
| Extraction & summary of price lists / chats | **On-device first** (`PREFER_ON_DEVICE`, Gemini Nano in Chrome) with automatic cloud fallback | Frequent, latency-sensitive, and *private* — a shop's purchase prices are business secrets that should not have to leave the device. On-device is also free and works offline. |
| Price comparison, WhatsApp negotiation draft, promo caption | **Cloud only** (`ONLY_IN_CLOUD`, Gemini) | Creative writing where output quality matters most and requests are infrequent — exactly what the big cloud model is for. |

A visible **Hybrid Router panel** makes the architecture tangible: it logs
every request with the mode that was requested, the path that *actually*
served it (read from `response.inferenceSource`), and its latency — and a
mode toggle (Auto / On-device / Cloud) lets anyone watch the fallback happen
live.

## ✨ Features

- Paste any messy text (or use the built-in Indonesian sample data) →
  structured item/price table + summary + estimated shopping total.
- One click from the extraction to three cloud-generated drafts:
  📊 price comparison across suppliers, 💬 a polite WhatsApp negotiation
  message, 📣 a promo caption.
- Live on-device status: detects Chrome's Prompt API availability and can
  warm up / download Gemini Nano from a button (`initializeDeviceModel`
  with download progress).
- Bilingual reality: the UI and outputs are in Bahasa Indonesia, because
  that is the language of the shop owners it serves.

## 🧱 Tech

- React + Vite + TypeScript
- Firebase AI Logic (JS SDK v13) — `getAI` with `GoogleAIBackend`
  (Gemini Developer API, free tier), hybrid models via
  `InferenceMode.PREFER_ON_DEVICE / ONLY_ON_DEVICE / ONLY_IN_CLOUD`
- Firebase App Check (reCAPTCHA Enterprise in production, debug provider on
  localhost) to protect the API quota
- No custom backend — the browser talks to Firebase AI Logic directly.

## 🚀 Run it locally

Prerequisites: Node 20+, a Firebase project with **AI Logic enabled**
(Gemini Developer API), and Chrome 139+ on desktop for on-device inference.

```bash
npm install
cp .env.example .env.local   # fill in your reCAPTCHA v3 site key
npm run dev
```

1. Put your own Firebase web config in `src/lib/config.ts`
   (Firebase console → Project settings → Your apps → Web).
2. **App Check on localhost:** the app enables the App Check debug provider
   automatically on `localhost`. Open the dev console, copy the printed
   `Firebase App Check debug token: …`, and register it in
   Firebase console → App Check → Apps → ⋮ → *Manage debug tokens*.
3. **On-device model:** Chrome may need
   `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` enabled.
   Use the in-app *Siapkan Model On-Device* button to download Gemini Nano.

## ☁️ Deploy

```bash
npm run build
firebase deploy --only hosting
```

Before production use, register the web app in App Check with a real
reCAPTCHA Enterprise key and set `VITE_RECAPTCHA_SITE_KEY` at build time.

## 📄 License

Apache License 2.0 — see [LICENSE](LICENSE).

Built by Panji Asmoro (solo) for #BuildHybridAI 2026.
