import { useEffect, useRef, useState } from "react";
import {
  checkDeviceStatus,
  draftWithCloud,
  extractData,
  warmUpDeviceModel,
  type DeviceStatus,
  type DraftKind,
  type Extraction,
  type RouteMode,
  type RouterEntry,
} from "./lib/ai";
import { SAMPLES } from "./lib/samples";
import "./App.css";

const rp = new Intl.NumberFormat("id-ID");

function sourceBadge(source: RouterEntry["source"]) {
  if (source === "ON_DEVICE") return <span className="badge device">⚡ On-device</span>;
  if (source === "IN_CLOUD") return <span className="badge cloud">☁️ Cloud</span>;
  return <span className="badge unknown">—</span>;
}

const DEVICE_STATUS_TEXT: Record<DeviceStatus, string> = {
  available: "⚡ Gemini Nano siap di perangkat ini",
  downloadable: "⚡ Gemini Nano bisa diunduh (klik Siapkan Model)",
  downloading: "⏳ Gemini Nano sedang diunduh…",
  unavailable: "☁️ Gemini Nano tidak tersedia — mode cloud aktif",
  unsupported: "☁️ Browser ini tanpa Prompt API — mode cloud aktif",
};

export default function App() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<RouteMode>("auto");
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>("unsupported");
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKind, string>>>({});
  const [log, setLog] = useState<RouterEntry[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    void checkDeviceStatus().then(setDeviceStatus);
  }, []);

  function pushLog(entry: Omit<RouterEntry, "id" | "time">) {
    idRef.current += 1;
    const full: RouterEntry = {
      ...entry,
      id: idRef.current,
      time: new Date().toLocaleTimeString("id-ID"),
    };
    setLog((prev) => [full, ...prev].slice(0, 9));
  }

  async function handleWarmUp() {
    setBusy("warmup");
    setDownloadPct(0);
    const ok = await warmUpDeviceModel((pct) => setDownloadPct(pct));
    setBusy(null);
    setDownloadPct(null);
    if (ok) setDeviceStatus("available");
    else setDeviceStatus(await checkDeviceStatus());
  }

  async function handleExtract() {
    if (!input.trim() || busy) return;
    setBusy("extract");
    setError(null);
    // If Gemini Nano is already downloaded, warm it up inside this user
    // gesture so PREFER_ON_DEVICE can actually serve on-device.
    if (mode !== "cloud" && deviceStatus === "available") {
      await warmUpDeviceModel();
    }
    try {
      const { data, entry } = await extractData(input, mode);
      pushLog(entry);
      setExtraction(data);
      setDrafts({});
    } catch (err) {
      const e = err as Error & { entry?: Omit<RouterEntry, "id" | "time"> };
      if (e.entry) pushLog(e.entry);
      setError(
        mode === "device"
          ? "Model on-device belum siap di browser ini. Coba mode Otomatis (otomatis fallback ke cloud) atau klik Siapkan Model dulu."
          : `Ekstraksi gagal: ${e.message}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleDraft(kind: DraftKind) {
    if (!extraction || busy) return;
    setBusy(kind);
    setError(null);
    try {
      const { text, entry } = await draftWithCloud(kind, extraction);
      pushLog(entry);
      setDrafts((prev) => ({ ...prev, [kind]: text }));
    } catch (err) {
      const e = err as Error & { entry?: Omit<RouterEntry, "id" | "time"> };
      if (e.entry) pushLog(e.entry);
      setError(`Draf cloud gagal: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  const totalEstimate =
    extraction?.items.reduce((sum, it) => sum + (it.price ?? 0), 0) ?? 0;
  const deviceCount = log.filter((e) => e.source === "ON_DEVICE").length;

  return (
    <div className="page">
      <header className="hero">
        <h1>🏪 WarungWise</h1>
        <p className="tagline">
          Asisten AI <strong>hybrid</strong> untuk pemilik warung &amp; UMKM —
          ekstraksi cepat &amp; privat <em>di perangkat</em> (Gemini Nano),
          draf berkualitas dari <em>cloud</em> (Gemini), semuanya lewat{" "}
          <strong>Firebase AI Logic</strong>.
        </p>
        <div className="status-pill">{DEVICE_STATUS_TEXT[deviceStatus]}</div>
        {(deviceStatus === "downloadable" || deviceStatus === "downloading") && (
          <button className="btn ghost" onClick={handleWarmUp} disabled={busy !== null}>
            {busy === "warmup"
              ? `Mengunduh model… ${downloadPct ?? 0}%`
              : "Siapkan Model On-Device"}
          </button>
        )}
      </header>

      <section className="card router">
        <div className="router-head">
          <h2>🧭 Hybrid Router</h2>
          <div className="mode-toggle" role="group" aria-label="Mode inferensi">
            <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")}>
              Otomatis
            </button>
            <button className={mode === "device" ? "on" : ""} onClick={() => setMode("device")}>
              ⚡ Di Perangkat
            </button>
            <button className={mode === "cloud" ? "on" : ""} onClick={() => setMode("cloud")}>
              ☁️ Cloud
            </button>
          </div>
        </div>
        <p className="hint">
          Mode Otomatis = <code>PREFER_ON_DEVICE</code>: Gemini Nano melayani
          bila siap, cloud menjadi fallback otomatis. Panel ini mencatat jalur
          asli tiap permintaan dari <code>response.inferenceSource</code>.
          {log.length > 0 && (
            <>
              {" "}
              Sejauh ini <strong>{deviceCount}</strong> dari {log.length}{" "}
              permintaan dilayani on-device (gratis &amp; privat).
            </>
          )}
        </p>
        {log.length === 0 ? (
          <p className="empty">Belum ada permintaan. Jalankan ekstraksi pertama di bawah.</p>
        ) : (
          <ul className="log">
            {log.map((e) => (
              <li key={e.id} className={e.ok ? "" : "fail"}>
                <span className="log-time">{e.time}</span>
                <span className="log-feature">{e.feature}</span>
                <span className="log-req">{e.requested}</span>
                {sourceBadge(e.source)}
                <span className="log-lat">{e.ok ? `${e.latencyMs} ms` : "gagal"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>1️⃣ Tempel teks berantakan</h2>
        <p className="hint">
          Daftar harga supplier, chat WhatsApp, atau catatan stok — apa adanya.
          Ekstraksi berjalan hybrid: di perangkat bila bisa, jadi data harga
          warungmu tidak harus meninggalkan laptopmu.
        </p>
        <div className="samples">
          {SAMPLES.map((s) => (
            <button key={s.label} className="chip" onClick={() => setInput(s.text)}>
              {s.label}
            </button>
          ))}
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tempel teks di sini…"
          rows={9}
        />
        <button
          className="btn primary"
          onClick={handleExtract}
          disabled={busy !== null || !input.trim()}
        >
          {busy === "extract" ? "Mengekstrak…" : "⚡ Ekstrak & Ringkas"}
        </button>
        {error && <p className="error">{error}</p>}
      </section>

      {extraction && (
        <section className="card">
          <h2>2️⃣ Hasil ekstraksi</h2>
          <p className="summary">{extraction.summary}</p>
          {extraction.items.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Barang</th>
                  <th>Qty</th>
                  <th>Harga</th>
                  <th>Satuan</th>
                  <th>Supplier</th>
                </tr>
              </thead>
              <tbody>
                {extraction.items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.name}</td>
                    <td>{it.qty}</td>
                    <td className="num">
                      {it.price !== null ? `Rp ${rp.format(it.price)}` : "—"}
                    </td>
                    <td>{it.unit}</td>
                    <td>{it.supplier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty">Tidak ada item terdeteksi.</p>
          )}
          {totalEstimate > 0 && (
            <p className="total">
              Perkiraan total sekali belanja:{" "}
              <strong>Rp {rp.format(totalEstimate)}</strong>
            </p>
          )}
          {extraction.notes && <p className="notes">📌 {extraction.notes}</p>}
        </section>
      )}

      {extraction && (
        <section className="card">
          <h2>3️⃣ Buat dengan Cloud AI ☁️</h2>
          <p className="hint">
            Tugas menulis yang butuh kualitas bahasa terbaik diserahkan ke
            Gemini di cloud (<code>ONLY_IN_CLOUD</code>) — memakai hasil
            ekstraksi di atas sebagai konteks.
          </p>
          <div className="draft-btns">
            <button className="btn" onClick={() => handleDraft("compare")} disabled={busy !== null}>
              {busy === "compare" ? "Menyusun…" : "📊 Perbandingan harga"}
            </button>
            <button className="btn" onClick={() => handleDraft("negotiate")} disabled={busy !== null}>
              {busy === "negotiate" ? "Menulis…" : "💬 Draf negosiasi WA"}
            </button>
            <button className="btn" onClick={() => handleDraft("promo")} disabled={busy !== null}>
              {busy === "promo" ? "Menulis…" : "📣 Caption promosi"}
            </button>
          </div>
          {(Object.keys(drafts) as DraftKind[]).map(
            (kind) =>
              drafts[kind] && (
                <div className="draft" key={kind}>
                  <div className="draft-head">
                    <strong>
                      {kind === "compare"
                        ? "📊 Perbandingan harga"
                        : kind === "negotiate"
                          ? "💬 Draf negosiasi WhatsApp"
                          : "📣 Caption promosi"}
                    </strong>
                    <button
                      className="btn small"
                      onClick={() => void navigator.clipboard.writeText(drafts[kind] ?? "")}
                    >
                      Salin
                    </button>
                  </div>
                  <p className="draft-text">{drafts[kind]}</p>
                </div>
              ),
          )}
        </section>
      )}

      <footer>
        <p>
                    WarungWise v1.1 — dibangun untuk #BuildHybridAI 2026 dengan
          Firebase AI Logic (Gemini Nano on-device + Gemini cloud). Data
          pada mode on-device tidak pernah meninggalkan perangkatmu.
        </p>
      </footer>
    </div>
  );
}
