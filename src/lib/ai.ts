import { initializeApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  type GenerativeModel,
} from "firebase/ai";
import { firebaseConfig } from "./config";

// ---------------------------------------------------------------------------
// Firebase AI Logic — hybrid inference layer.
// Every AI call in WarungWise goes through Firebase AI Logic. Nothing else.
// On-device inference runs on Chrome's built-in Gemini Nano (Prompt API);
// cloud inference runs on Gemini via the Gemini Developer API (free tier).
// ---------------------------------------------------------------------------

const app = initializeApp(firebaseConfig);

// App Check protects the Gemini API quota from abuse. Production uses
// reCAPTCHA Enterprise / Fraud Defense (site key is a public identifier,
// set via env at build time). Firebase has deprecated reCAPTCHA Classic
// for new App Check registrations.
// On localhost we use the App Check debug provider instead: the SDK prints a
// debug token to the console, which is registered once in the Firebase
// console (App Check > Apps > Manage debug tokens).
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as
  | string
  | undefined;
const isLocal =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";
if (isLocal) {
  // Pin the debug token (from a gitignored .env.local) so it stays stable
  // across reloads and can be registered once in the console. Without a
  // pinned value the SDK would mint a fresh token on every page load.
  const pinned = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN as
    | string
    | undefined;
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    pinned ?? true;
}
if (recaptchaSiteKey) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
} else if (isLocal) {
  // Debug-provider only: the placeholder key is never used, because the
  // debug token above short-circuits provider attestation on localhost.
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider("localhost-debug-placeholder"),
    isTokenAutoRefreshEnabled: true,
  });
}

const ai = getAI(app, { backend: new GoogleAIBackend() });

export type RouteMode = "auto" | "device" | "cloud";
export type InferenceSource = "ON_DEVICE" | "IN_CLOUD" | "UNKNOWN";

export type RouterEntry = {
  id: number;
  time: string;
  feature: string;
  requested: string;
  source: InferenceSource;
  latencyMs: number;
  ok: boolean;
  note?: string;
};

const MODE_LABEL: Record<RouteMode, string> = {
  auto: "PREFER_ON_DEVICE",
  device: "ONLY_ON_DEVICE",
  cloud: "ONLY_IN_CLOUD",
};

function modeEnum(mode: RouteMode): InferenceMode {
  if (mode === "device") return InferenceMode.ONLY_ON_DEVICE;
  if (mode === "cloud") return InferenceMode.ONLY_IN_CLOUD;
  return InferenceMode.PREFER_ON_DEVICE;
}

let deviceInitStarted = false;
let deviceReady = false;

/**
 * Must be called from a user gesture (button click) before the first
 * on-device request — Chrome requires transient activation to start the
 * Gemini Nano download / session warm-up.
 */
export async function warmUpDeviceModel(
  onProgress?: (pct: number) => void,
): Promise<boolean> {
  if (deviceReady) return true;
  try {
    const probe = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
    });
    await probe.initializeDeviceModel((val: number) => {
      onProgress?.(Math.round(val * 100));
    });
    deviceReady = true;
    deviceInitStarted = true;
    return true;
  } catch {
    deviceInitStarted = true;
    return false;
  }
}

export function deviceWarmUpAttempted(): boolean {
  return deviceInitStarted;
}

type RunResult = {
  text: string;
  source: InferenceSource;
  latencyMs: number;
};

async function runModel(
  model: GenerativeModel,
  prompt: string,
  forcedSource?: InferenceSource,
): Promise<RunResult> {
  const started = performance.now();
  const result = await model.generateContent(prompt);
  const latencyMs = Math.round(performance.now() - started);
  // For PREFER_* modes the SDK reports which path served the request via
  // response.inferenceSource. For ONLY_* modes the serving path is true by
  // construction, so the caller passes it in.
  const rawSource = (result.response as { inferenceSource?: string })
    .inferenceSource;
  const source: InferenceSource =
    rawSource === "ON_DEVICE" || rawSource === "IN_CLOUD"
      ? rawSource
      : (forcedSource ?? "UNKNOWN");
  return { text: result.response.text(), source, latencyMs };
}

// ---------------------------------------------------------------------------
// Feature 1 — extraction + summary (the hybrid showcase).
// Frequent, private, latency-sensitive work: supplier price lists and
// customer chats should never have to leave the shop owner's device.
// ---------------------------------------------------------------------------

export type ExtractedItem = {
  name: string;
  qty: string;
  price: number | null;
  unit: string;
  supplier: string;
};

export type Extraction = {
  summary: string;
  items: ExtractedItem[];
  notes: string;
};

const EXTRACTION_PROMPT = (text: string) => `You are a data extraction engine for an Indonesian small shop (warung).
Read the messy text below (it may be a supplier price list, a WhatsApp chat, or handwritten stock notes, in Indonesian or mixed Indonesian/English).
Return ONLY a JSON object, no markdown fences, with this exact shape:
{
  "summary": "1-2 sentence summary of the text, in Indonesian",
  "items": [
    { "name": "product name", "qty": "quantity as written, or empty string", "price": 12345, "unit": "per unit e.g. kg, pcs, dus, or empty string", "supplier": "supplier name if stated, else empty string" }
  ],
  "notes": "anything important that is not an item (deadlines, minimum orders, payment terms), in Indonesian, or empty string"
}
Rules: price must be a plain number in Indonesian Rupiah without thousand separators (e.g. "Rp 12.500" -> 12500). If a price is not stated, use null. Keep product names as written. If there are no items, return an empty array.

TEXT:
"""
${text}
"""`;

function parseExtraction(raw: string): Extraction {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Extraction;
  if (!Array.isArray(parsed.items)) parsed.items = [];
  parsed.items = parsed.items.map((it) => ({
    name: String(it.name ?? ""),
    qty: String(it.qty ?? ""),
    price:
      typeof it.price === "number" && Number.isFinite(it.price)
        ? it.price
        : null,
    unit: String(it.unit ?? ""),
    supplier: String(it.supplier ?? ""),
  }));
  parsed.summary = String(parsed.summary ?? "");
  parsed.notes = String(parsed.notes ?? "");
  return parsed;
}

export async function extractData(
  text: string,
  mode: RouteMode,
): Promise<{ data: Extraction; entry: Omit<RouterEntry, "id" | "time"> }> {
  const model = getGenerativeModel(ai, {
    mode: modeEnum(mode),
    inCloudParams: { model: "gemini-3.5-flash-lite" },
  });
  // In Auto mode the SDK only reports inferenceSource when the on-device
  // model was a real candidate. If Gemini Nano is not fully downloaded on
  // this device, the request can only have been served by the cloud.
  let autoFallback: InferenceSource | undefined;
  if (mode === "auto") {
    const status = await checkDeviceStatus();
    if (status !== "available") autoFallback = "IN_CLOUD";
  }
  try {
    const { text: raw, source, latencyMs } = await runModel(
      model,
      EXTRACTION_PROMPT(text),
      mode === "device"
        ? "ON_DEVICE"
        : mode === "cloud"
          ? "IN_CLOUD"
          : autoFallback,
    );
    return {
      data: parseExtraction(raw),
      entry: {
        feature: "Ekstraksi & ringkasan",
        requested: MODE_LABEL[mode],
        source,
        latencyMs,
        ok: true,
      },
    };
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      entry: {
        feature: "Ekstraksi & ringkasan",
        requested: MODE_LABEL[mode],
        source: "UNKNOWN" as InferenceSource,
        latencyMs: 0,
        ok: false,
        note: err instanceof Error ? err.message.slice(0, 140) : "error",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Feature 2 — cloud drafting. Creative, quality-sensitive writing is what the
// big cloud model is for: price comparisons, WhatsApp negotiation drafts and
// promo captions in warm, natural Indonesian.
// ---------------------------------------------------------------------------

export type DraftKind = "compare" | "negotiate" | "promo";

const DRAFT_FEATURE: Record<DraftKind, string> = {
  compare: "Perbandingan harga (cloud)",
  negotiate: "Draf negosiasi WA (cloud)",
  promo: "Caption promosi (cloud)",
};

const DRAFT_PROMPT: Record<DraftKind, (ctx: string) => string> = {
  compare: (ctx) => `Kamu asisten pemilik warung di Indonesia. Berdasarkan data barang & harga berikut, buat perbandingan harga yang ringkas: kelompokkan barang yang sama dari supplier berbeda, tandai yang termurah, dan tutup dengan rekomendasi beli di mana saja + perkiraan total hemat. Tulis dalam Bahasa Indonesia, format poin-poin yang rapi, tanpa tabel markdown.

DATA:
${ctx}`,
  negotiate: (ctx) => `Kamu membantu pemilik warung menegosiasi harga lewat WhatsApp. Berdasarkan data barang & harga berikut, tulis SATU pesan WhatsApp yang sopan, hangat, dan singkat (maksimal 120 kata) untuk supplier yang harganya lebih mahal, meminta harga menyamai atau mendekati penawaran kompetitor, dengan menyebut 2-3 barang contoh. Bahasa Indonesia santai-sopan khas chat WA, boleh 1 emoji. Jangan mengarang nama orang.

DATA:
${ctx}`,
  promo: (ctx) => `Kamu membantu pemilik warung membuat promosi. Berdasarkan data barang berikut, tulis SATU caption promosi untuk status WhatsApp / media sosial warung: sebutkan 3-4 barang dengan harga menarik, ajakan membeli yang ramah, dan 3 hashtag relevan. Bahasa Indonesia, maksimal 80 kata, boleh emoji secukupnya.

DATA:
${ctx}`,
};

export async function draftWithCloud(
  kind: DraftKind,
  extraction: Extraction,
): Promise<{ text: string; entry: Omit<RouterEntry, "id" | "time"> }> {
  const model = getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: { model: "gemini-3.5-flash" },
  });
  const ctx = JSON.stringify(extraction, null, 2);
  try {
    const { text, source, latencyMs } = await runModel(
      model,
      DRAFT_PROMPT[kind](ctx),
      "IN_CLOUD",
    );
    return {
      text: text.trim(),
      entry: {
        feature: DRAFT_FEATURE[kind],
        requested: "ONLY_IN_CLOUD",
        source,
        latencyMs,
        ok: true,
      },
    };
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      entry: {
        feature: DRAFT_FEATURE[kind],
        requested: "ONLY_IN_CLOUD",
        source: "UNKNOWN" as InferenceSource,
        latencyMs: 0,
        ok: false,
        note: err instanceof Error ? err.message.slice(0, 140) : "error",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// On-device availability (Chrome Prompt API status, for the status pill).
// ---------------------------------------------------------------------------

export type DeviceStatus =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | "unsupported";

export async function checkDeviceStatus(): Promise<DeviceStatus> {
  try {
    const lm = (
      window as unknown as {
        LanguageModel?: { availability: () => Promise<string> };
      }
    ).LanguageModel;
    if (!lm) return "unsupported";
    const status = await lm.availability();
    if (status === "available") return "available";
    if (status === "downloadable") return "downloadable";
    if (status === "downloading") return "downloading";
    return "unavailable";
  } catch {
    return "unsupported";
  }
}
