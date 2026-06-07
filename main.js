/* ========= グローバルエラーハンドラー ========= */
window.addEventListener('error', function(e) {
  console.error('Global error caught:', e.error);
  console.error('Error message:', e.message);
  console.error('Error filename:', e.filename);
  console.error('Error line:', e.lineno);
  
  // ユーザーに表示
  const resultArea = document.getElementById("result");
  if (resultArea) {
    resultArea.innerHTML = `
      <div class="card" style="background:#fee2e2;color:#991b1b;padding:14px;">
        <b>エラーが発生しました</b><br>
        ${e.message}<br>
        <small>F12キーを押してコンソールで詳細を確認してください</small>
      </div>
    `;
  }
});

window.addEventListener('unhandledrejection', function(e) {
  console.error('Unhandled promise rejection:', e.reason);
});



/* ========= 設定 ========= */
const WORKER_URL = "https://acrcloud.shirokuma0822.workers.dev/";
const APP_VERSION = "3.3.0";

/* ========= クラウド同期 設定 ========= */
/**
 * CLOUD_USER_ID_KEY: localStorage に保存する匿名ユーザー ID のキー名。
 * ログイン不要で端末ごとに UUID を自動発行し、Neon の music_history.user_id に使用する。
 * 別端末で同じ履歴を使いたい場合は「クラウド同期 ID」をメモしておく必要がある。
 */
const CLOUD_USER_ID_KEY = "cloud_user_id";


/* ========= DOM要素（初期化は後で） ========= */
let fileInput, fileSend, dropZone, resultArea, mbDetail, historyArea;
let debug, debugToggle;
let recBtn, stopBtn, recSec, counter, micSelect, recordPreview, sendRecordBtn;
let historySearch, clearHistoryBtn, exportHistoryBtn;

/* ========= グローバル変数 ========= */
let currentRecordedBlob = null;
let currentTrackInfo = null;

/* ========= APIレスポンスキャッシュ（セッション内メモリ） =========
 * 同じ曲を連続認識したとき MusicBrainz / iTunes / YouTube / Wikipedia / Spotify を
 * 再フェッチしないようにする。キーは "title::artist"（小文字正規化）。
 * タブを閉じると消える。ストレージには書かない。
 */
const _apiCache = new Map();
const _CACHE_TTL_MS = 30 * 60 * 1000; // 30分

function _cacheKey(title, artist) {
  return `${title}::${artist}`.toLowerCase().trim();
}
function _cacheGet(ns, title, artist) {
  const k = `${ns}:${_cacheKey(title, artist)}`;
  const entry = _apiCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.ts > _CACHE_TTL_MS) { _apiCache.delete(k); return null; }
  return entry.data;
}
function _cacheSet(ns, title, artist, data) {
  _apiCache.set(`${ns}:${_cacheKey(title, artist)}`, { ts: Date.now(), data });
}

/* ========= IndexedDB セットアップ ========= */
let db;
const DB_NAME = "music-history";
const STORE = "items";

function initIndexedDB() {
  
  
  if (!window.indexedDB) {
    console.warn('IndexedDB not supported, history features will be disabled');
    return;
  }
  
  try {
    const openReq = indexedDB.open(DB_NAME, 2);

    openReq.onupgradeneeded = e => {
      const d = e.target.result;
      // v1: items store
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        s.createIndex("starred", "starred", { unique: false });
      } else if (e.oldVersion < 2) {
        // v1 → v2: starred インデックスを追加
        const s = e.target.transaction.objectStore(STORE);
        if (!s.indexNames.contains("starred")) {
          s.createIndex("starred", "starred", { unique: false });
        }
      }
    };

    openReq.onsuccess = e => {
      
      db = e.target.result;
      loadHistory();
    };

    openReq.onerror = e => {
      console.error("IndexedDB error:", e);
      console.warn('History features will be disabled');
    };
  } catch (err) {
    console.error('IndexedDB initialization failed:', err);
  }
}

/* ========= デバッグログ（構造化カードUI版） ========= */

// セッション管理
const _dbg = {
  entries: [],          // 全ログエントリ
  counter: 0,           // 連番
  sessionStart: Date.now(),
  panel: null,          // #debugEntries DOM
  enabled: false
};

// フェーズ定義 (label → {color, icon})
const DBG_PHASE = {
  "前処理":      { color: "#059669", bg: "#ecfdf5", icon: "🟢" },
  "ACRCloud":    { color: "#7c3aed", bg: "#f5f3ff", icon: "🟣" },
  "MusicBrainz": { color: "#1d4ed8", bg: "#eff6ff", icon: "🔵" },
  "Apple Music": { color: "#c2410c", bg: "#fff7ed", icon: "🟠" },
  "YouTube":     { color: "#dc2626", bg: "#fef2f2", icon: "🔴" },
  "システム":    { color: "#4b5563", bg: "#f9fafb", icon: "⚪" },
};

function _dbgPhase(label) {
  for (const key of Object.keys(DBG_PHASE)) {
    if (label.startsWith(key)) return { phase: key, ...DBG_PHASE[key] };
  }
  return { phase: "システム", ...DBG_PHASE["システム"] };
}

function _dbgElapsed() {
  const ms = Date.now() - _dbg.sessionStart;
  return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(2)}s`;
}

// エントリを1件レンダリング
function _dbgRenderEntry(entry) {
  const ph = _dbgPhase(entry.label);
  const statusColor = entry.status === "error" ? "#dc2626"
                    : entry.status === "warn"  ? "#b45309"
                    : ph.color;

  const card = document.createElement("div");
  card.className = "dbg-card" + (entry.status === "error" ? " dbg-card--error" : "");
  card.dataset.id = entry.id;

  const isAutoExpand = entry.status === "error" || entry.status === "warn";

  card.innerHTML = `
    <div class="dbg-card-header" onclick="this.parentElement.classList.toggle('dbg-card--open')">
      <span class="dbg-phase-icon">${ph.icon}</span>
      <span class="dbg-label" style="color:${statusColor}">${entry.label}</span>
      <span class="dbg-meta">
        <span class="dbg-ts">${entry.ts}</span>
        <span class="dbg-elapsed">+${entry.elapsed}</span>
        ${entry.duration_ms != null ? `<span class="dbg-dur">${entry.duration_ms}ms</span>` : ""}
        <span class="dbg-status dbg-status--${entry.status}">${entry.status === "error" ? "✗" : entry.status === "warn" ? "⚠" : "✓"}</span>
      </span>
      <span class="dbg-toggle-icon">▶</span>
    </div>
    <div class="dbg-card-body">
      <pre class="dbg-pre">${escapeHtml(JSON.stringify(entry.data, null, 2))}</pre>
    </div>`;

  if (isAutoExpand) card.classList.add("dbg-card--open");
  return card;
}

// パネルにエントリを先頭挿入
function _dbgPush(entry) {
  _dbg.entries.unshift(entry);
  if (!_dbg.panel) _dbg.panel = document.getElementById("debugEntries");
  if (_dbg.panel) {
    const card = _dbgRenderEntry(entry);
    _dbg.panel.insertBefore(card, _dbg.panel.firstChild);
  }
  _dbgUpdateSummary();
}

function _dbgUpdateSummary() {
  const el = document.getElementById("debugSummary");
  if (!el) return;
  const errors = _dbg.entries.filter(e => e.status === "error").length;
  el.textContent = `${_dbg.entries.length}件 / 経過 ${_dbgElapsed()}${errors ? ` / ⚠ エラー ${errors}件` : ""}`;
}

// 公開API: debugLog(label, data, options)
//   options: { status: "ok"|"error"|"warn", duration_ms: number }
function debugLog(label, data, options = {}) {
  // エラー時のみconsoleにも出力
  if (options.status === "error") {
    console.error(`[DBG] ${label}`, data);
  }

  if (!_dbg.enabled) return;

  const now = new Date();
  const entry = {
    id: ++_dbg.counter,
    ts: now.toLocaleTimeString("ja-JP", { hour12: false, fractionalSecondDigits: 3 }),
    elapsed: _dbgElapsed(),
    label,
    data,
    status: options.status || "ok",
    duration_ms: options.duration_ms ?? null
  };
  _dbgPush(entry);
}

// Workerレスポンスの _debug フィールドと本体ペイロードをすべてログに流す
function debugLogWorker(phase, json, httpStatus) {
  // ── ペイロード本体（生データ）──────────────────
  const payload = { ...json };
  delete payload._debug;  // _debugは別途表示するので除外
  if (Object.keys(payload).length > 0) {
    debugLog(`${phase}: レスポンスペイロード（生）`, payload,
      { status: httpStatus >= 400 ? "error" : "ok" });
  }

  if (!json._debug) return;
  const d = json._debug;

  // ── worker_received ──────────────────────────
  if (d.worker_received) {
    debugLog(`${phase}: Worker受信メタ`, d.worker_received);
  }

  // ── upstream_call（複数対応）──────────────────
  const calls = Array.isArray(d.upstream_call) ? d.upstream_call : (d.upstream_call ? [d.upstream_call] : []);
  calls.forEach(c => {
    debugLog(`${phase}: →上流APIコール`, c, { duration_ms: c.duration_ms });
  });

  // ── upstream_response（生）────────────────────
  if (d.upstream_response) {
    const isErr = d.upstream_response.error ||
      (d.upstream_response.http_status && d.upstream_response.http_status >= 400);
    debugLog(`${phase}: ←上流APIレスポンス`, d.upstream_response,
      { status: isErr ? "error" : "ok" });
  }
}

// デバッグパネルの初期化（DOMContentLoaded後に呼ぶ）
function initDebugPanel() {
  const toggle = document.getElementById("debugToggle");
  const panel  = document.getElementById("debugPanel");
  if (!toggle || !panel) return;

  toggle.addEventListener("change", () => {
    _dbg.enabled = toggle.checked;
    panel.style.display = toggle.checked ? "block" : "none";
    if (toggle.checked) _dbgUpdateSummary();
  });

  document.getElementById("debugClear")?.addEventListener("click", () => {
    _dbg.entries = [];
    _dbg.counter = 0;
    _dbg.sessionStart = Date.now();
    const entries = document.getElementById("debugEntries");
    if (entries) entries.innerHTML = "";
    _dbgUpdateSummary();
  });

  document.getElementById("debugExport")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(_dbg.entries, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `debug_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.json`;
    a.click();
  });

  document.getElementById("debugExpandAll")?.addEventListener("click", () => {
    document.querySelectorAll(".dbg-card").forEach(c => c.classList.add("dbg-card--open"));
  });

  document.getElementById("debugCollapseAll")?.addEventListener("click", () => {
    document.querySelectorAll(".dbg-card").forEach(c => c.classList.remove("dbg-card--open"));
  });
}

/* ========= ユーティリティ関数 ========= */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDuration(ms) {
  if (!ms) return "不明";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatDate(date) {
  if (!date) return "不明";
  return date;
}

/* ========= 音声前処理ユーティリティ ========= */

// ステータス表示ヘルパー
function setStatus(msg, icon = "⏳") {
  resultArea.innerHTML = `
    <div class="card" style="display:flex;align-items:center;gap:12px;padding:18px;">
      <span class="loading-spinner"></span>
      <span style="color:var(--txt-secondary);font-size:14px;">${icon} ${escapeHtml(msg)}</span>
    </div>`;
}

// ArrayBuffer → WAV Blob（16bit PCM, モノラル）
function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4,  36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,  true);          // PCM
  view.setUint16(22, 1,  true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2,  true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  // float32 → int16
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ダウンサンプリング（線形補間）
function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio  = fromRate / toRate;
  const out    = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const lo  = Math.floor(pos);
    const hi  = Math.min(lo + 1, input.length - 1);
    out[i]    = input[lo] + (input[hi] - input[lo]) * (pos - lo);
  }
  return out;
}

// メインの前処理パイプライン
const TRIM_SEC      = 10;       // 先頭10秒を切り出し
const TARGET_RATE   = 16000;    // ACRCloud推奨サンプルレート
const MAX_SEND_BYTES = 900_000; // 送信上限 (~900KB)
const MIN_BYTES      = 2000;

async function preprocessAudio(file) {
  // 1. ファイル種別チェック
  if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
    throw new Error('音声・動画ファイルを選択してください');
  }
  debugLog("前処理: ファイル受信", { name: file.name, size_bytes: file.size, size_kb: (file.size/1024).toFixed(1), type: file.type, last_modified: new Date(file.lastModified).toISOString() });

  // 2. 極小ファイルチェック
  if (file.size < MIN_BYTES) throw new Error('音声が短すぎます');

  // 小さいファイル（<500KB）かつWAV/MP3ならそのまま送る
  if (file.size < 500_000 && (file.type === 'audio/wav' || file.type === 'audio/mpeg' || file.type === 'audio/mp3')) {
    debugLog("前処理: 小ファイル — 前処理スキップ", { size_bytes: file.size, size_kb: (file.size/1024).toFixed(1), reason: "500KB未満のWAV/MP3はそのまま送信" });
    return file;
  }

  // 3. デコード
  setStatus("音声をデコード中…", "🔍");
  const arrayBuffer = await file.arrayBuffer();
  let audioBuffer;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    await ctx.close();
  } catch (e) {
    debugLog("前処理: デコード失敗 — 生ファイルをそのまま送信", { error: e.message }, { status: "warn" });
    // デコード不可ならそのまま送る（ファイルが大きすぎる場合のみ警告）
    if (file.size > MAX_SEND_BYTES) throw new Error(`ファイルが大きすぎます（${(file.size/1024/1024).toFixed(1)}MB）。10秒以下の音声を使用してください`);
    return file;
  }

  debugLog("前処理: デコード完了", {
    duration_sec: +audioBuffer.duration.toFixed(2),
    sample_rate_hz: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    total_samples: audioBuffer.length
  });

  // 4. トリミング（TRIM_SEC秒超なら先頭だけ使う）
  const trimSamples = Math.min(
    audioBuffer.length,
    Math.floor(TRIM_SEC * audioBuffer.sampleRate)
  );
  const wasTrimmed = audioBuffer.length > trimSamples;
  if (wasTrimmed) {
    setStatus(`${TRIM_SEC}秒にトリミング中…`, "✂️");
    debugLog("前処理: トリミング実行", { before_sec: +audioBuffer.duration.toFixed(2), after_sec: TRIM_SEC, cut_sec: +(audioBuffer.duration - TRIM_SEC).toFixed(2) });
  }

  // 5. モノラルミックスダウン（複数chを平均）
  let mono = new Float32Array(trimSamples);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const chData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < trimSamples; i++) mono[i] += chData[i];
  }
  for (let i = 0; i < mono.length; i++) mono[i] /= audioBuffer.numberOfChannels;

  // 6. サンプルレート正規化（TARGET_RATEへダウンサンプル）
  let finalSamples = mono;
  let finalRate    = audioBuffer.sampleRate;
  if (audioBuffer.sampleRate > TARGET_RATE) {
    setStatus("サンプルレートを変換中…", "🔧");
    finalSamples = downsample(mono, audioBuffer.sampleRate, TARGET_RATE);
    finalRate    = TARGET_RATE;
    debugLog("前処理: ダウンサンプル実行", { from_hz: audioBuffer.sampleRate, to_hz: TARGET_RATE, ratio: (audioBuffer.sampleRate / TARGET_RATE).toFixed(2) });
  }

  // 7. WAVエンコード
  setStatus("WAVに変換中…", "🎵");
  const wavBlob = encodeWAV(finalSamples, finalRate);
  debugLog("前処理: WAV生成完了", {
    size_bytes: wavBlob.size,
    size_kb: (wavBlob.size / 1024).toFixed(1),
    sample_rate_hz: finalRate,
    was_trimmed: wasTrimmed,
    original_size_kb: (file.size / 1024).toFixed(1),
    compression_ratio: (file.size / wavBlob.size).toFixed(2)
  });

  // 8. 最終サイズチェック
  if (wavBlob.size > MAX_SEND_BYTES) {
    throw new Error(`変換後も大きすぎます（${(wavBlob.size/1024).toFixed(0)}KB）。より短い音声を使用してください`);
  }

  const resultFile = new File([wavBlob], "audio.wav", { type: "audio/wav" });
  // フィンガープリント描画用にサンプルデータを添付（File自体には影響しない）
  resultFile._fpSamples    = finalSamples;
  resultFile._fpRate       = finalRate;
  resultFile._fpDurationSec = trimSamples / finalRate;
  return resultFile;
}

/* ========= 🔬 ビジュアルフィンガープリント描画 ========= */
/**
 * PCMサンプル列をスペクトログラム（ヒートマップ）としてCanvasに描画する。
 * ACRCloudへ送信する16kHzモノラルPCMを可視化し、
 * どの時間帯のどの音域にどれだけの音量があるかを確認できる。
 *
 * 表示構成:
 *   左側ラベル  : 周波数帯（低音/中音/高音）
 *   中央Canvas  : スペクトログラム本体（横=時間、縦=周波数、色=音の強さ）
 *   右側バー    : dBスケール（色と強さの対応）
 *   下部        : 時間軸
 *   ホバー      : マウス位置の時間・周波数・相対音量をリアルタイム表示
 *
 * アルゴリズム: Goertzelアルゴリズム + ハニング窓（対数周波数軸）
 *
 * @param {Float32Array} samples     - 16kHzモノラルPCMサンプル列
 * @param {number}       rate        - サンプルレート（通常16000）
 * @param {number}       durationSec - 音声の秒数
 */
async function drawFingerprint(samples, rate, durationSec) {
  const section    = document.getElementById('fingerprintSection');
  const canvas     = document.getElementById('fingerprintCanvas');
  const metaEl     = document.getElementById('fpMeta');
  const tooltip    = document.getElementById('fpTooltip');
  const timeAxis   = document.getElementById('fpTimeAxis');
  const freqLabels = document.getElementById('fpFreqLabels');
  if (!section || !canvas || samples.length === 0) return;

  // --- 解析パラメータ ---
  const FFT_SIZE    = 2048;  // 窓サイズ（周波数解像度）
  const HOP         = Math.round(rate * 0.025); // 25msホップ（時間解像度）
  const DISPLAY_BINS = 80;   // 周波数ビン数（縦解像度）
  const MAX_FRAMES   = 400;  // 最大フレーム数（横解像度）

  // ハニング窓（スペクトル漏れ抑制）
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));

  // 対数スケール周波数ビン配置（80Hz〜rate/2）
  const minLogF = Math.log2(80);
  const maxLogF = Math.log2(rate / 2);
  const binKs   = new Uint16Array(DISPLAY_BINS);
  const binHz   = new Float32Array(DISPLAY_BINS); // 各ビンの実周波数（Hz）
  for (let di = 0; di < DISPLAY_BINS; di++) {
    const logF  = minLogF + (maxLogF - minLogF) * (di / (DISPLAY_BINS - 1));
    const hz    = Math.pow(2, logF);
    binHz[di]   = hz;
    binKs[di]   = Math.round((hz / (rate / 2)) * (FFT_SIZE / 2));
  }

  // フレーム間引き
  const totalFrames = Math.floor((samples.length - FFT_SIZE) / HOP) + 1;
  const step        = Math.max(1, Math.ceil(totalFrames / MAX_FRAMES));
  const frameIdxs   = [];
  for (let fi = 0; fi < totalFrames; fi += step) frameIdxs.push(fi);
  const nF = frameIdxs.length;

  // Goertzelアルゴリズムで全フレームのパワー計算
  const allFrames = new Float32Array(nF * DISPLAY_BINS); // フラット配列で高速化
  for (let fii = 0; fii < nF; fii++) {
    const start = frameIdxs[fii] * HOP;
    for (let di = 0; di < DISPLAY_BINS; di++) {
      const k    = binKs[di];
      const wk   = (2 * Math.PI * k) / FFT_SIZE;
      const cos2 = 2 * Math.cos(wk);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let n = 0; n < FFT_SIZE; n++) {
        const s = (start + n < samples.length) ? samples[start + n] * hann[n] : 0;
        s0 = s + cos2 * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const re  = s1 - s2 * Math.cos(wk);
      const im  = s2 * Math.sin(wk);
      const mag = Math.sqrt(re * re + im * im) / (FFT_SIZE * 0.5);
      allFrames[fii * DISPLAY_BINS + di] = 20 * Math.log10(Math.max(mag, 1e-10));
    }
  }

  // 正規化（全体のmin/max）
  let globalMin = Infinity, globalMax = -Infinity;
  for (let i = 0; i < allFrames.length; i++) {
    if (allFrames[i] < globalMin) globalMin = allFrames[i];
    if (allFrames[i] > globalMax) globalMax = allFrames[i];
  }
  const range = globalMax - globalMin || 1;

  // ヒートマップカラー（紺→青緑→黄→赤）
  function heatColor(t) {
    const stops = [
      [0.00, [13,  13,  43 ]],
      [0.15, [13,  43,  110]],
      [0.30, [26,  92,  138]],
      [0.45, [15,  122, 94 ]],
      [0.60, [58,  170, 46 ]],
      [0.75, [200, 200, 0  ]],
      [0.88, [255, 102, 0  ]],
      [1.00, [255, 17,  17 ]],
    ];
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    const u = (t - t0) / (t1 - t0);
    return [
      Math.round(c0[0] + (c1[0] - c0[0]) * u),
      Math.round(c0[1] + (c1[1] - c0[1]) * u),
      Math.round(c0[2] + (c1[2] - c0[2]) * u),
    ];
  }

  // --- Canvas描画 ---
  const wrap  = canvas.parentElement;
  const W_CSS = wrap.clientWidth || 600;
  const H_CSS = 180;
  canvas.width  = W_CSS;
  canvas.height = H_CSS;
  canvas.style.width  = W_CSS + 'px';
  canvas.style.height = H_CSS + 'px';

  const ctx     = canvas.getContext('2d');
  const cellW   = W_CSS / nF;
  const cellH   = H_CSS / DISPLAY_BINS;
  const imgData = ctx.createImageData(W_CSS, H_CSS);

  for (let fii = 0; fii < nF; fii++) {
    const xStart = Math.round(fii * cellW);
    const xEnd   = Math.min(Math.round((fii + 1) * cellW), W_CSS);
    for (let bi = 0; bi < DISPLAY_BINS; bi++) {
      // 周波数軸反転（低周波=下）
      const yStart = Math.round((DISPLAY_BINS - 1 - bi) * cellH);
      const yEnd   = Math.min(Math.round((DISPLAY_BINS - bi) * cellH), H_CSS);
      const db     = allFrames[fii * DISPLAY_BINS + bi];
      const t      = Math.pow(Math.max(0, Math.min(1, (db - globalMin) / range)), 0.65);
      const [r, g, b] = heatColor(t);
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          const idx = (y * W_CSS + x) * 4;
          imgData.data[idx]     = r;
          imgData.data[idx + 1] = g;
          imgData.data[idx + 2] = b;
          imgData.data[idx + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // 周波数帯区切り線（Canvas上にオーバーレイ）
  const bands = [
    { hz: 250,  label: '低音域',  note: '〜250Hz' },
    { hz: 2000, label: '中音域',  note: '250Hz〜2kHz' },
    { hz: 8000, label: '高音域',  note: '2k〜8kHz' },
  ];
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 0.5;
  for (const { hz } of bands) {
    const logF = Math.log2(Math.min(hz, rate / 2));
    const t    = Math.max(0, Math.min(1, (logF - minLogF) / (maxLogF - minLogF)));
    const y    = H_CSS - t * H_CSS;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W_CSS, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // --- 左側：周波数帯ラベル生成 ---
  if (freqLabels) {
    freqLabels.innerHTML = '';
    const bandDefs = [
      { top: 0.0,  bot: 0.33, label: '高音', sub: '2k〜8k' },
      { top: 0.33, bot: 0.67, label: '中音', sub: '250〜2k' },
      { top: 0.67, bot: 1.0,  label: '低音', sub: '80〜250' },
    ];
    for (const { top, bot, label, sub } of bandDefs) {
      const el = document.createElement('div');
      el.className = 'fp-freq-label fp-band-label';
      el.style.cssText = `position:absolute;top:${top*100}%;height:${(bot-top)*100}%;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;width:100%;`;
      el.innerHTML = `<span style="color:rgba(255,255,255,.55);font-size:8px;font-weight:700;">${label}</span><span style="color:rgba(255,255,255,.25);font-size:7px;">${sub}Hz</span>`;
      freqLabels.appendChild(el);
    }
    freqLabels.style.position = 'relative';
  }

  // --- 下部：時間軸ラベル生成 ---
  if (timeAxis) {
    timeAxis.innerHTML = '';
    const nTicks = Math.min(10, Math.floor(durationSec));
    const step   = durationSec <= 5 ? 1 : durationSec <= 10 ? 2 : 5;
    for (let t = 0; t <= durationSec; t += step) {
      const span = document.createElement('span');
      span.textContent = `${t}s`;
      timeAxis.appendChild(span);
    }
  }

  // --- メタ情報 ---
  const hopMs = ((HOP / rate) * 1000).toFixed(0);
  if (metaEl) metaEl.textContent =
    `${nF}フレーム × ${DISPLAY_BINS}ビン | 窓幅 ${(FFT_SIZE/rate*1000).toFixed(0)}ms | ホップ ${hopMs}ms`;

  // --- ホバーツールチップ ---
  if (tooltip) {
    // 音域の人間向け説明
    function getFreqBand(hz) {
      if (hz < 80)   return '超低音';
      if (hz < 250)  return '低音（ベース・ドラム）';
      if (hz < 500)  return '低中音（男声・ギター低域）';
      if (hz < 2000) return '中音（ボーカル・楽器主音）';
      if (hz < 4000) return '高中音（子音・倍音）';
      return '高音（空気感・シンバル）';
    }
    // 音量の説明
    function getDbDesc(t) {
      if (t > 0.85) return '非常に強い';
      if (t > 0.65) return '強い';
      if (t > 0.40) return '中程度';
      if (t > 0.20) return '弱い';
      return 'ほぼ無音';
    }

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      const fii  = Math.min(nF - 1, Math.floor((mx / W_CSS) * nF));
      const bi   = Math.min(DISPLAY_BINS - 1, DISPLAY_BINS - 1 - Math.floor((my / H_CSS) * DISPLAY_BINS));
      const timeSec = (frameIdxs[fii] * HOP / rate).toFixed(2);
      const hz      = binHz[bi];
      const db      = allFrames[fii * DISPLAY_BINS + bi];
      const t       = Math.max(0, Math.min(1, (db - globalMin) / range));
      const hzLabel = hz >= 1000 ? `${(hz/1000).toFixed(1)}kHz` : `${Math.round(hz)}Hz`;

      tooltip.innerHTML =
        `<b>${timeSec}秒</b> / <b>${hzLabel}</b><br>` +
        `音量: ${getDbDesc(t)}（${(db).toFixed(1)} dB）<br>` +
        `<span style="color:rgba(255,255,255,.55);font-size:10px;">${getFreqBand(hz)}</span>`;

      // ツールチップ位置（画面端で折り返し）
      let tx = mx + 12, ty = my - 60;
      if (tx + 180 > W_CSS) tx = mx - 190;
      if (ty < 0) ty = my + 8;
      tooltip.style.left    = tx + 'px';
      tooltip.style.top     = ty + 'px';
      tooltip.style.display = 'block';
    });
    canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  }

  section.style.display = 'block';
}

/* ========= 音声ファイル送信 ========= */
async function send(file) {
  if (!file) {
    alert("ファイルがありません");
    return;
  }

  resultArea.textContent = "判定中…";
  mbDetail.textContent = "未取得";

  // YouTubeセクションをリセット
  const ytSection = document.getElementById("youtubeSection");
  const ytContent = document.getElementById("youtubeContent");
  if (ytSection) ytSection.style.display = "none";
  if (ytContent) ytContent.innerHTML = "";
  if (currentYTPlayer) {
    try { currentYTPlayer.destroy(); } catch(e) {}
    currentYTPlayer = null;
  }
  window._ytVideoList = [];

  // 前処理パイプライン
  let processedFile;
  try {
    processedFile = await preprocessAudio(file);
  } catch (err) {
    resultArea.innerHTML = `<div class="card" style="background:var(--error-light);color:var(--error);padding:18px;">⚠️ ${escapeHtml(err.message)}</div>`;
    return;
  }

  // フィンガープリント描画（認識リクエストと並走して実行）
  let fingerprintPromise = Promise.resolve();
  if (processedFile._fpSamples) {
    fingerprintPromise = drawFingerprint(
      processedFile._fpSamples,
      processedFile._fpRate,
      processedFile._fpDurationSec
    ).catch(e => console.warn('Fingerprint draw error:', e));
  }

  setStatus("サーバーに送信中…", "📡");
  const fd = new FormData();
  fd.append("file", processedFile);

  debugLog("ACRCloud: Workerへ送信", {
    file_name: processedFile.name,
    file_size_bytes: processedFile.size,
    file_type: processedFile.type,
    worker_url: WORKER_URL
  });

  let json;
  const acrT0 = Date.now();
  try {
    const res = await fetch(WORKER_URL, { method: "POST", body: fd });
    const acrDuration = Date.now() - acrT0;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
    debugLog("ACRCloud: Workerレスポンス受信", {
      http_status:     res.status,
      success:         json.success,
      duration_ms:     acrDuration,
      acr_status_code: json.acr?.status?.code,
      acr_status_msg:  json.acr?.status?.msg,
      result_count:    json.acr?.metadata?.music?.length ?? 0,
      raw_acr:         json.acr ?? null
    }, { duration_ms: acrDuration, status: json.success ? "ok" : "warn" });
    debugLogWorker("ACRCloud", json, res.status);
  } catch (err) {
    debugLog("ACRCloud: 送信エラー", { error: err.message }, { status: "error", duration_ms: Date.now() - acrT0 });
    resultArea.innerHTML = `<div class="card" style="background:var(--error-light);color:var(--error);padding:18px;">通信エラー: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const list = json?.acr?.metadata?.music;
  if (!list) {
    
    debugLog('ACRCloud: 認識失敗', { acr_status: json?.acr?.status, raw_acr: json?.acr }, { status: 'warn' });
    resultArea.innerHTML = `<div class="card">認識できませんでした</div>`;
    return;
  }

  debugLog('ACRCloud: 認識成功', {
    result_count: list.length,
    candidates: list.map(m => ({
      title: m.title,
      artist: m.artists?.[0]?.name,
      album: m.album?.name,
      score: m.score,
      release_date: m.release_date,
      genres: m.genres,
      external_ids: m.external_ids,
      external_metadata: {
        spotify: m.external_metadata?.spotify ? {
          track_id: m.external_metadata.spotify.track?.id,
          album_id: m.external_metadata.spotify.album?.id
        } : null,
        youtube: m.external_metadata?.youtube || null,
        deezer: m.external_metadata?.deezer ? {
          track_id: m.external_metadata.deezer.track?.id
        } : null
      }
    })),
    raw_acr_status: json.acr?.status
  });
  showResult(list, json.acr);
}

/* ========= 認識結果表示 v2.9.2 ========= */

function pseudoConfidence(score, index) {
  return Math.max(30, Math.min(99, Math.round(score - index * 7)));
}

/* ③ 信頼度バー（色付き） */
function buildConfidenceBar(conf) {
  const cls   = conf >= 90 ? 'conf-high' : conf >= 70 ? 'conf-mid' : 'conf-low';
  const label = conf >= 90 ? '高信頼' : conf >= 70 ? '中信頼' : '要確認';
  return `<div class="conf-bar-wrap">
    <div class="conf-bar-track"><div class="conf-bar-fill ${cls}" style="width:${conf}%"></div></div>
    <div class="conf-meta">
      <span class="conf-pct ${cls}">${conf}%</span>
      <span class="conf-lbl ${cls}">${label}</span>
    </div>
  </div>`;
}

/* ② ストリーミングリンク（Apple Musicは後で直接リンクへ差し替え） */
function buildStreamingLinks(title, artist, containerId, m = {}) {
  const q   = encodeURIComponent(title + ' ' + artist);
  const qMV = encodeURIComponent(title + ' ' + artist + ' official music video');

  // Spotify: track ID があれば直接リンク、なければ検索
  const spotifyTrackId = m.external_metadata?.spotify?.track?.id;
  const spotifyHref    = spotifyTrackId
    ? `https://open.spotify.com/track/${spotifyTrackId}`
    : `https://open.spotify.com/search/${q}`;
  const spotifyClass   = spotifyTrackId ? 'stream-btn stream-spotify stream-spotify-direct' : 'stream-btn stream-spotify';
  const spotifyTitle   = spotifyTrackId ? 'Spotify で開く（直接リンク）' : 'Spotify で検索';

  // Deezer: track ID があれば直接リンク、なければ検索
  const deezerTrackId  = m.external_metadata?.deezer?.track?.id;
  const deezerHref     = deezerTrackId
    ? `https://www.deezer.com/track/${deezerTrackId}`
    : `https://www.deezer.com/search/${q}`;
  const deezerClass    = deezerTrackId ? 'stream-btn stream-deezer stream-deezer-direct' : 'stream-btn stream-deezer';
  const deezerTitle    = deezerTrackId ? 'Deezer で開く（直接リンク）' : 'Deezer で検索';

  return `<div class="streaming-links" id="${containerId}">
    <a class="stream-btn stream-yt"       target="_blank" href="https://www.youtube.com/results?search_query=${qMV}" title="YouTube でMVを検索">🎬 MV</a>
    <a class="${spotifyClass}"            target="_blank" href="${spotifyHref}" title="${spotifyTitle}" data-search-url="https://open.spotify.com/search/${q}">🎵 Spotify</a>
    <a class="${deezerClass}"             target="_blank" href="${deezerHref}"  title="${deezerTitle}"  data-search-url="https://www.deezer.com/search/${q}">🎶 Deezer</a>
    <a class="stream-btn stream-apple"    target="_blank" href="https://music.apple.com/search?term=${q}" data-search-url="https://music.apple.com/search?term=${q}" title="Apple Music で検索">🍎 Apple Music</a>
    <button class="stream-btn stream-copy" onclick="copyTrackInfo(this)" title="曲情報をコピー">📋 コピー</button>
    <a class="stream-btn stream-share"    href="javascript:void(0)" onclick="shareTrack('${title}','${artist}')" title="共有">📤 共有</a>
  </div>`;
}

/* ④ 曲情報クリップボードコピー */
function copyTrackInfo(btn) {
  const card  = btn.closest('.candidate-card');
  const title  = card?.dataset.title  || '';
  const artist = card?.dataset.artist || '';
  const album  = card?.dataset.album  || '';
  const text   = album ? `${title} / ${artist}（${album}）` : `${title} / ${artist}`;

  const doFallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('コピーしました', 'success'); } catch { showToast('コピー失敗', 'error'); }
    document.body.removeChild(ta);
  };

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => {
        btn.textContent = '✅ コピー済み';
        setTimeout(() => { btn.textContent = '📋 コピー'; }, 2000);
        showToast('コピーしました', 'success');
      })
      .catch(doFallback);
  } else {
    doFallback();
  }
}

/* ⑤ 候補カード1枚を描画（表示のみ、API呼び出しなし） */
function renderCandidateCard(m, i, conf, artist) {
  const score = m.score || 0;
  const album = m.album?.name || '';
  const streamId = `stream_${Date.now()}_${i}`;

  // アルバムアート（初期値）
  let albumArt = '';
  if (m.external_metadata?.spotify?.album?.images?.[0]?.url) {
    albumArt = m.external_metadata.spotify.album.images[0].url;
  } else if (m.external_metadata?.deezer?.album?.id) {
    albumArt = `https://e-cdns-images.dzcdn.net/images/cover/${m.external_metadata.deezer.album.id}/500x500.jpg`;
  }

  const cardDiv = document.createElement('div');
  cardDiv.className = i === 0 ? 'card candidate-card candidate-active' : 'card candidate-card candidate-collapsed';
  cardDiv.dataset.idx    = i;
  cardDiv.dataset.title  = m.title;
  cardDiv.dataset.artist = artist;
  cardDiv.dataset.album  = album;

  // アート部分
  let artHtml = '';
  if (albumArt) {
    const artId = `albumArt_${Date.now()}_${i}`;
    const safeTitle  = m.title.replace(/[^a-zA-Z0-9]/g, '_');
    const safeArtist = artist.replace(/[^a-zA-Z0-9]/g, '_');
    artHtml = `<div class="album-art-container" data-source="画像: Spotify / Deezer">
      <img src="${escapeHtml(albumArt)}" alt="Album Art" class="album-art"
           id="${artId}" data-original-url="${escapeHtml(albumArt)}"
           onerror="this.style.display='none'" onclick="toggleArtSize(this)">
      <div class="album-art-controls">
        <button class="art-btn" onclick="downloadArtByElement('${artId}','${safeTitle}_${safeArtist}')">💾 DL</button>
        <button class="art-btn" onclick="copyArtUrlByElement('${artId}')">🔗 URL</button>
        <button class="art-btn" onclick="openArtNewTabByElement('${artId}')">🖼️ 開く</button>
      </div>
    </div>`;
  }

  // ヘッダーラベル
  const labelHtml = i === 0
    ? `<div class="cand-label cand-label-best">🎯 最有力</div>`
    : `<div class="cand-label cand-label-alt">💡 候補 ${i + 1}
        <button class="cand-toggle-btn" onclick="toggleCandidateBody(this)">▶ 詳細を見る</button>
       </div>`;

  // ⑤ ISRC / UPC バッジ
  const isrc = m.external_ids?.isrc;
  const upc  = m.external_ids?.upc;
  const isrcUpcHtml = (isrc || upc) ? `
    <div class="isrc-upc-row">
      ${isrc ? `<a class="isrc-badge" href="https://musicbrainz.org/search?query=${encodeURIComponent(isrc)}&type=recording" target="_blank" data-source="出典: ACRCloud" title="MusicBrainzで検索">ISRC ${escapeHtml(isrc)}</a>` : ''}
      ${upc  ? `<span class="upc-badge" data-source="出典: ACRCloud" title="UPCコード">UPC ${escapeHtml(upc)}</span>` : ''}
    </div>` : '';

  // 本体（2件目以降は折りたたみ）
  const bodyStyle = i === 0 ? '' : 'style="display:none"';
  const bodyHtml = `<div class="cand-body" ${bodyStyle}>
    ${artHtml}
    <div class="cand-title" data-source="出典: ACRCloud">${escapeHtml(m.title)}</div>
    <div class="cand-artist" data-source="出典: ACRCloud">🎤 ${escapeHtml(artist)}</div>
    ${album ? `<div class="cand-album" data-source="出典: ACRCloud">💿 ${escapeHtml(album)}</div>` : ''}
    ${buildConfidenceBar(conf)}
    <div class="cand-raw-score" data-source="ACRCloud識別スコア（0〜100）">ACRCloud score: ${Math.round(score)}</div>
    ${isrcUpcHtml}
    ${buildStreamingLinks(m.title, artist, streamId, m)}
    <button class="share-card-btn" onclick="openShareCardModal(this.closest('.candidate-card'))">🖼️ シェアカードを作成</button>
    <button class="compare-add-btn" onclick="addToComparison(currentTrackInfo)">➕ 比較リストに追加</button>
    ${i === 0 ? `<button class="spotify-playlist-btn" id="spotifyPlaylistBtn" onclick="addToSpotifyPlaylist('${escapeHtml(m.title).replace(/'/g,"\\'")}','${escapeHtml(artist).replace(/'/g,"\\'")}')">🎵 プレイリストに追加</button>` : ''}
    ${i > 0 ? `<button class="cand-activate-btn" onclick="activateCandidateByIndex(${i})">この候補を使う →</button>` : ''}
  </div>`;

  cardDiv.innerHTML = labelHtml + bodyHtml;
  return cardDiv;
}

/* 2件目以降の折りたたみトグル */
function toggleCandidateBody(btn) {
  const body = btn.closest('.candidate-card').querySelector('.cand-body');
  const collapsed = body.style.display === 'none';
  body.style.display = collapsed ? '' : 'none';
  btn.textContent = collapsed ? '▲ 閉じる' : '▶ 詳細を見る';
}

/* ⑤ その候補でAPI群を起動（MusicBrainz/iTunes/YouTube） */
let _candidateList = [];

function activateCandidateByIndex(i) {
  const m = _candidateList[i];
  if (!m) return;
  const artist = m.artists?.[0]?.name || '';
  const score  = m.score || 0;
  const conf   = pseudoConfidence(score, i);

  // アクティブ状態を切り替え
  resultArea.querySelectorAll('.candidate-card').forEach((c, idx) => {
    c.classList.toggle('candidate-active', idx === i);
  });

  // 展開する
  const card = resultArea.querySelectorAll('.candidate-card')[i];
  if (card) {
    const body = card.querySelector('.cand-body');
    const btn  = card.querySelector('.cand-toggle-btn');
    if (body) body.style.display = '';
    if (btn)  btn.textContent = '▲ 閉じる';
  }

  activateCandidate(m, artist, conf, card);
}

function activateCandidate(m, artist, conf, cardDiv) {
  const album = m.album?.name || '';

  // リリース日・ジャンル・ISRCをcurrentTrackInfoに保存（シェアカードで使用）
  const releaseDate = m.release_date || '';
  const genre       = m.genres?.[0]?.name || '';
  const isrc        = m.external_ids?.isrc || '';
  const spotifyUrl  = m.external_metadata?.spotify?.track?.id
    ? `https://open.spotify.com/track/${m.external_metadata.spotify.track.id}`
    : '';

  currentTrackInfo = {
    title: m.title, artist, albumArt: '', album,
    releaseDate, genre, isrc, spotifyUrl,
    durationMs: 0  // iTunes / Spotify から後で更新
  };

  // 履歴
  if (db) {
    try {
      addHistory({ title: m.title, artist, confidence: conf, time: Date.now() });
      syncToCloud({ title: m.title, artist, album, genre, isrc, confidence: conf, time: Date.now() });
      if (historySearch) loadHistory(historySearch.value);
    } catch (e) { console.error('History error:', e); }
  }

  // MusicBrainz（→内部でYouTubeも起動）
  fetchMusicBrainz(m.title, artist).catch(e => console.error('MusicBrainz:', e));


  // ① Spotify 埋め込みプレーヤー
  const spotifyTrackId = m.external_metadata?.spotify?.track?.id || null;
  showSpotifyEmbed(spotifyTrackId);

  // Spotify Web API でトラック詳細取得（プレビューURL・メタデータ補完）
  fetchSpotifyTrackInfo(m.title, artist, spotifyTrackId).catch(e => console.error('Spotify API:', e));

  // Apple Music（アートワーク + リンク直接化）
  fetchItunesArtwork(m.title, artist).then(itunesData => {
    if (!itunesData) return;
    currentTrackInfo.albumArt   = itunesData.url600 || '';
    currentTrackInfo.itunesData = itunesData;
    if (itunesData.durationMs)  currentTrackInfo.durationMs = itunesData.durationMs;

    // カード内のアルバムアートを更新
    if (cardDiv) {
      const img = cardDiv.querySelector('.album-art');
      if (img && itunesData.url600) {
        img.src = itunesData.url600;
        img.dataset.originalUrl = itunesData.url1200 || itunesData.url600;
      } else if (!img && itunesData.url600) {
        // アルバムアートが存在しない場合: コンテナ + 画像 + コントロールを作成
        const artId = `albumArt_itunes_${Date.now()}`;
        const safeTitle  = (m.title || '').replace(/[^a-zA-Z0-9]/g, '_');
        const safeArtist = (artist || '').replace(/[^a-zA-Z0-9]/g, '_');
        const container = document.createElement('div');
        container.className = 'album-art-container';
        container.dataset.source = '画像: Apple Music / iTunes';
        container.innerHTML = `
          <img src="${escapeHtml(itunesData.url600)}" alt="Album Art" class="album-art"
               id="${artId}" data-original-url="${escapeHtml(itunesData.url1200 || itunesData.url600)}"
               onerror="this.style.display='none'" onclick="toggleArtSize(this)">
          <div class="album-art-controls">
            <button class="art-btn" onclick="downloadArtByElement('${artId}','${safeTitle}_${safeArtist}')">💾 DL</button>
            <button class="art-btn" onclick="copyArtUrlByElement('${artId}')">🔗 URL</button>
            <button class="art-btn" onclick="openArtNewTabByElement('${artId}')">🖼️ 開く</button>
          </div>`;
        const body = cardDiv.querySelector('.cand-body');
        if (body) body.insertBefore(container, body.firstChild);
      }

      // ② Apple Musicリンクを直接リンクへ差し替え
      if (itunesData.trackViewUrl) {
        const amLink = cardDiv.querySelector('.stream-apple');
        if (amLink) {
          amLink.href = itunesData.trackViewUrl;
          amLink.title = 'Apple Music で開く（直接リンク）';
          amLink.classList.add('stream-apple-direct');
        }
      }
    }

    // previewSection に iTunes プレビューを表示
    showItunesPreview(itunesData);

    // MusicBrainz側のiTunesセクション更新（既に描画済みの場合）
    updateMBiTunesSection(itunesData);
  }).catch(e => console.error('iTunes:', e));
}

/* MusicBrainzセクションのApple Music情報を追記 */
function updateMBiTunesSection(itunesData) {
  if (!mbDetail) return;
  const mbCard = mbDetail.querySelector('.mb-detail');
  if (!mbCard || mbCard.querySelector('.itunes-info')) return;
  const lastSection = mbCard.querySelector('.mb-section:last-child');
  if (!lastSection) return;
  lastSection.insertAdjacentHTML('afterend', `
    <div class="itunes-info">
      <h4 data-source="出典: Apple Music / iTunes Search API">🍎 Apple Music</h4>
      <div style="margin-top:6px;">
        <a target="_blank" href="${escapeHtml(itunesData.trackViewUrl)}" class="mb-link" style="font-size:13px;">Apple Music で開く</a>
      </div>
    </div>`);
}

/* ⑤ メイン showResult */
function showResult(list, acrData) {
  resultArea.innerHTML = '';
  _candidateList = list;  // 後でactivateCandidateByIndexから参照

  list.forEach((m, i) => {
    const artist = m.artists?.[0]?.name || '';
    const score  = m.score || 0;
    const conf   = pseudoConfidence(score, i);
    resultArea.appendChild(renderCandidateCard(m, i, conf, artist));
  });

  // 最有力候補を自動アクティベート
  if (list.length > 0) {
    const m      = list[0];
    const artist = m.artists?.[0]?.name || '';
    const conf   = pseudoConfidence(m.score || 0, 0);
    activateCandidate(m, artist, conf, resultArea.querySelector('.candidate-card'));
  }
}

/* ========= ⑥ Wikipedia概要取得 ========= */
async function fetchWikipedia(artist, wikidataId) {
  if (!artist) return;

  const cached = _cacheGet("wiki", artist, wikidataId || "");
  if (cached) { debugLog("Wikipedia: キャッシュ使用", { artist }); displayWikipediaInfo(cached); return; }

  debugLog("Wikipedia: Workerへ送信", { artist, wikidata_id: wikidataId, endpoint: `${WORKER_URL}wikipedia` });
  const wikiT0 = Date.now();

  try {
    const res = await fetch(`${WORKER_URL}wikipedia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artist, wikidata_id: wikidataId })
    });
    const wikiDuration = Date.now() - wikiT0;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    debugLog("Wikipedia: Workerレスポンス受信", {
      success: json.success,
      duration_ms: wikiDuration,
      language: json.language ?? null,
      title: json.title ?? null,
      url: json.url ?? null,
      thumbnail: json.thumbnail ?? null,
      summary_length: json.summary?.length ?? 0,
      summary_preview: json.summary?.slice(0, 300) ?? null,
      error: json.error ?? null
    }, { duration_ms: wikiDuration, status: json.success ? 'ok' : 'warn' });
    debugLogWorker("Wikipedia", json, res.status);

    if (!json.success || !json.summary) return;

    _cacheSet("wiki", artist, wikidataId || "", json);
    displayWikipediaInfo(json);
  } catch (err) {
    debugLog("Wikipedia: エラー", { message: err.message }, { status: 'error', duration_ms: Date.now() - wikiT0 });
  }
}

function displayWikipediaInfo(data) {
  if (!mbDetail) return;
  const mbCard = mbDetail.querySelector('.mb-detail');
  if (!mbCard) return;

  // 既に表示済みなら更新しない
  if (mbCard.querySelector('.wiki-section')) return;

  const langLabel = data.language === 'ja' ? '日本語版' : '英語版';
  const thumbHtml = data.thumbnail
    ? `<img src="${escapeHtml(data.thumbnail)}" alt="Wikipedia thumbnail" class="wiki-thumb">`
    : '';

  const wikiHtml = `
    <div class="mb-section wiki-section">
      <h4>📖 Wikipedia <span class="wiki-lang-badge">${langLabel}</span></h4>
      <div class="wiki-body">
        ${thumbHtml}
        <p class="wiki-summary">${escapeHtml(data.summary)}</p>
      </div>
      ${data.url ? `<a href="${escapeHtml(data.url)}" target="_blank" class="mb-link wiki-link">Wikipedia で読む</a>` : ''}
    </div>`;

  // MusicBrainzリンクセクションの直前に挿入
  const mbLinkSection = [...mbCard.querySelectorAll('.mb-section')]
    .find(s => s.querySelector('.mb-link[href*="musicbrainz.org"]'));
  if (mbLinkSection) {
    mbLinkSection.insertAdjacentHTML('beforebegin', wikiHtml);
  } else {
    mbCard.insertAdjacentHTML('beforeend', wikiHtml);
  }
}

/* ========= 履歴管理（完全版） ========= */
/* ========= 履歴管理（完全版） ========= */
function addHistory(item) {
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(item);
  } catch (err) {
    console.error('addHistory error:', err);
  }
}

/* ========= クラウド同期 関数群 ========= */

/**
 * 匿名ユーザー ID を取得または生成する。
 * localStorage に保存済みであればそれを返す。
 * なければ crypto.randomUUID() で新規発行して保存する。
 */
function getCloudUserId() {
  let id = localStorage.getItem(CLOUD_USER_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        }));
    localStorage.setItem(CLOUD_USER_ID_KEY, id);
  }
  return id;
}

/**
 * 認識した楽曲を Worker 経由で Neon に非同期保存する。
 * 保存結果は UI の同期インジケーターに反映する。
 * 失敗してもローカル IndexedDB には影響しない。
 *
 * @param {{title:string, artist:string, confidence:number, time:number}} item
 */
async function syncToCloud(item) {
  const userId = getCloudUserId();
  showSyncIndicator("sending");
  try {
    const res = await fetch(`${WORKER_URL}cloud/sync`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        user_id:       userId,
        title:         item.title,
        artist:        item.artist,
        album:         item.album        || "",
        genre:         item.genre        || "",
        isrc:          item.isrc         || "",
        confidence:    item.confidence,
        recognized_at: new Date(item.time).toISOString()
      })
    });
    const json = await res.json();
    showSyncIndicator(json.success ? "ok" : "error");
  } catch {
    showSyncIndicator("error");
  }
}

/**
 * 履歴セクションのヘッダー部に表示するクラウド同期インジケーターを更新する。
 * @param {"sending"|"ok"|"error"} status
 */
function showSyncIndicator(status) {
  const el = document.getElementById("cloudSyncIndicator");
  if (!el) return;
  const map = {
    sending: { text: "☁️ 同期中…",   cls: "sync-sending" },
    ok:      { text: "☁️ 同期済み",   cls: "sync-ok"      },
    error:   { text: "☁️ 同期失敗",   cls: "sync-error"   }
  };
  const s = map[status] || map.error;
  el.textContent  = s.text;
  el.className    = `sync-indicator ${s.cls}`;
  el.style.display = "";
  // "ok" は 4 秒後に自動で非表示
  if (status === "ok") {
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.style.display = "none"; }, 4000);
  }
}

/**
 * ページ読み込み時に自分のクラウド履歴を差分自動取得する。
 * すでにローカルにある time と同一のものはスキップする（重複防止）。
 */
/**
 * ページ読み込み時・定期実行（5分おき）に呼ばれるバックグラウンド自動同期。
 * クラウドに存在してローカルにない履歴を差分インポートする。
 * 新規取得件数が 1 件以上の場合にトーストで通知する。
 */
async function autoSyncFromCloud() {
  const uid = getCloudUserId();
  try {
    const res  = await fetch(`${WORKER_URL}cloud/history`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid, limit: 500 })
    });
    const json = await res.json();
    if (!json.success || !json.items?.length) return;

    // ローカルの time 一覧を取得
    const localTimes = await new Promise(resolve => {
      if (!db) return resolve(new Set());
      const times = new Set();
      const tx = db.transaction(STORE, "readonly");
      tx.objectStore(STORE).openCursor().onsuccess = e => {
        const c = e.target.result;
        if (c) { times.add(new Date(c.value.time).toISOString().slice(0, 19)); c.continue(); }
        else resolve(times);
      };
    });

    let added = 0;
    for (const item of json.items) {
      const isoKey = new Date(item.recognized_at).toISOString().slice(0, 19);
      if (localTimes.has(isoKey)) continue;
      await new Promise(resolve => {
        if (!db) { resolve(); return; }
        const tx  = db.transaction(STORE, "readwrite");
        const req = tx.objectStore(STORE).add({
          title: item.title, artist: item.artist,
          confidence: item.confidence || 0,
          time: new Date(item.recognized_at).getTime()
        });
        req.onsuccess = () => { added++; resolve(); };
        req.onerror   = () => resolve();
      });
    }
    if (added > 0) {
      if (historySearch) loadHistory(historySearch.value);
      showToast(`☁️ ${added} 件をクラウドから同期しました`, "success");
    }
    // 最終同期日時を更新
    _updateLastSyncTime();
  } catch (err) {
    console.warn("[CloudSync] 自動同期失敗:", err.message);
  }
}

/**
 * 最終クラウド同期日時を localStorage に記録し、モーダル内の表示を更新する。
 */
function _updateLastSyncTime() {
  const now = new Date().toISOString();
  localStorage.setItem("cloud_last_sync", now);
  const el = document.getElementById("cloudLastSyncTime");
  if (el) el.textContent = new Date(now).toLocaleString("ja-JP");
}

/** 起動時に最終同期日時をモーダルに反映する。 */
function _restoreLastSyncTime() {
  const saved = localStorage.getItem("cloud_last_sync");
  const el    = document.getElementById("cloudLastSyncTime");
  if (el) el.textContent = saved ? new Date(saved).toLocaleString("ja-JP") : "未同期";
}

/**
 * 自分の認識回数ランキング（ユーザー別）を Worker から取得してモーダルに表示する。
 */
async function loadUserRanking() {
  const el = document.getElementById("cloudUserRankingList");
  if (!el) return;
  el.innerHTML = "<div class='cloud-sync-hint'>読み込み中…</div>";
  try {
    const uid = getCloudUserId();
    const res  = await fetch(`${WORKER_URL}cloud/ranking/user`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid })
    });
    const json = await res.json();
    if (!json.success || !json.ranking?.length) {
      el.innerHTML = "<div class='cloud-sync-hint'>データがありません</div>";
      return;
    }
    el.innerHTML = json.ranking.map((item, i) => `
      <div class="ranking-item">
        <span class="rank-num rank-num--${i < 3 ? ["gold","silver","bronze"][i] : "normal"}">${i + 1}</span>
        <div class="ranking-item-info">
          <div class="ranking-item-title">${escapeHtml(item.title)}</div>
          <div class="ranking-item-artist">${escapeHtml(item.artist)}</div>
        </div>
        <span class="ranking-count">${item.count}<span class="ranking-count-unit">回</span></span>
      </div>`).join("");
  } catch {
    el.innerHTML = "<div class='cloud-sync-hint'>取得できませんでした</div>";
  }
}

/**
 * restoreCloudHistoryFromInput() / restoreCloudHistoryById() から呼ばれる共通処理。
 *
 * @param {string} userId  インポート元の user_id
 * @returns {Promise<number>} インポートした件数
 */
async function _importCloudHistory(userId) {
  const res = await fetch(`${WORKER_URL}cloud/history`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ user_id: userId, limit: 200 })
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);

  let added = 0;
  for (const item of json.items) {
    await new Promise((resolve) => {
      if (!db) { resolve(); return; }
      const tx  = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).add({
        title:      item.title,
        artist:     item.artist,
        confidence: item.confidence || 0,
        time:       new Date(item.recognized_at).getTime()
      });
      req.onsuccess = () => { added++; resolve(); };
      req.onerror   = () => resolve();
    });
  }
  return added;
}

/* ========= クラウド同期モーダル ========= */

/** クラウド同期モーダルを開く。ID 表示・同期件数を取得する。 */
async function openCloudSyncModal() {
  const modal = document.getElementById("cloudSyncModal");
  if (!modal) return;

  // 自分の ID を表示
  const uid = getCloudUserId();
  const idEl = document.getElementById("cloudSyncModalId");
  if (idEl) idEl.textContent = uid;

  // 入力欄・ステータスをリセット
  const input  = document.getElementById("cloudSyncImportId");
  const status = document.getElementById("cloudSyncStatus");
  if (input)  input.value = "";
  if (status) { status.style.display = "none"; status.textContent = ""; }

  modal.classList.add("is-open");

  // 同期済み件数・ユーザーランキングを非同期取得
  await Promise.all([refreshCloudSyncCount(), loadUserRanking()]);
}

/** クラウド同期モーダルを閉じる。 */
function closeCloudSyncModal() {
  const modal = document.getElementById("cloudSyncModal");
  if (modal) modal.classList.remove("is-open");
}

/** Neon から自分の同期件数を取得してモーダルに表示する。 */
async function refreshCloudSyncCount() {
  const countEl = document.getElementById("cloudSyncCount");
  if (!countEl) return;
  try {
    const uid = getCloudUserId();
    const res = await fetch(`${WORKER_URL}cloud/history`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ user_id: uid, limit: 500 })
    });
    const json = await res.json();
    if (json.success) {
      countEl.textContent = `${json.items.length} 件がクラウドに保存されています`;
    } else {
      countEl.textContent = "取得できませんでした";
    }
  } catch {
    countEl.textContent = "取得できませんでした";
  }
}

/**
 * モーダルの入力欄に入力された ID を使って別端末の履歴を復元する。
 * 成功すれば入力欄を自分の ID で上書きして以降の同期もその ID で行う。
 */
async function restoreCloudHistoryFromInput() {
  const input   = document.getElementById("cloudSyncImportId");
  const status  = document.getElementById("cloudSyncStatus");
  const btn     = document.getElementById("cloudSyncRestoreBtn");
  const importId = input?.value.trim();

  if (!importId) {
    setCloudSyncStatus("error", "⚠️ 同期 ID を入力してください");
    return;
  }
  // UUID 形式の簡易バリデーション
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) {
    setCloudSyncStatus("error", "⚠️ ID の形式が正しくありません");
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "復元中…"; }
  setCloudSyncStatus("info", "☁️ クラウドから読み込み中…");

  try {
    const added = await _importCloudHistory(importId);

    // 自分の ID を入力した ID に切り替え（以降の同期もこの ID で行われる）
    localStorage.setItem(CLOUD_USER_ID_KEY, importId);
    const idEl = document.getElementById("cloudSyncModalId");
    if (idEl) idEl.textContent = importId;
    if (input) input.value = "";

    if (historySearch) loadHistory(historySearch.value);
    await refreshCloudSyncCount();
    setCloudSyncStatus("ok", `✅ ${added} 件を復元しました。同期 ID をこの端末に引き継ぎました。`);
  } catch (err) {
    setCloudSyncStatus("error", `❌ 復元に失敗しました: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "復元"; }
  }
}

/**
 * 自分のクラウド同期 ID をクリップボードにコピーする。
 */
async function copyCloudUserId() {
  const uid = getCloudUserId();
  const btn = document.getElementById("cloudSyncCopyBtn");
  try {
    await navigator.clipboard.writeText(uid);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = "✅ コピー済み";
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
  } catch {
    // clipboard API が使えない場合（旧ブラウザ）はフォールバック
    const el = document.createElement("textarea");
    el.value = uid;
    el.style.position = "fixed";
    el.style.opacity  = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    if (btn) {
      btn.textContent = "✅ コピー済み";
      setTimeout(() => { btn.textContent = "コピー"; }, 2000);
    }
  }
}

/**
 * クラウド同期モーダルのステータスメッセージを更新する。
 * @param {"ok"|"error"|"info"} type
 * @param {string} message
 */
function setCloudSyncStatus(type, message) {
  const el = document.getElementById("cloudSyncStatus");
  if (!el) return;
  el.style.display = "";
  el.className = `cloud-sync-status cloud-sync-status--${type}`;
  el.textContent = message;
}

/* ========= ランキング 関数群 ========= */

/**
 * Worker 経由で Neon からランキングを取得して描画する。
 * @param {"all"|"month"} period  累計 or 今月
 */
async function loadRanking(period = "all") {
  const list = document.getElementById("rankingList");
  if (!list) return;

  // タブのアクティブ状態を更新
  document.querySelectorAll(".ranking-tab").forEach(btn => {
    btn.classList.toggle("ranking-tab--active", btn.dataset.period === period);
  });

  list.innerHTML = '<div class="ranking-loading">読み込み中…</div>';

  try {
    const res  = await fetch(`${WORKER_URL}cloud/ranking?period=${period}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    renderRanking(json.ranking, period);
  } catch (err) {
    list.innerHTML = `<div class="ranking-error">ランキングを読み込めませんでした<br><small>${err.message}</small></div>`;
  }
}

/**
 * ランキングデータを HTML リストとして描画する。
 * @param {Array<{title:string, artist:string, count:number}>} items
 * @param {"all"|"month"} period
 */
function renderRanking(items, period) {
  const list = document.getElementById("rankingList");
  if (!list) return;

  if (!items || items.length === 0) {
    const label = period === "month" ? "今月" : "まだ";
    list.innerHTML = `<div class="ranking-empty">${label}認識データがありません</div>`;
    return;
  }

  // 1位の count を基準に棒グラフ幅を計算
  const maxCount = items[0]?.count || 1;

  list.innerHTML = items.map((item, i) => {
    const rank      = i + 1;
    const rankClass = rank <= 3 ? `rank-num--${rank}` : "rank-num--other";
    const barWidth  = Math.max(4, Math.round((item.count / maxCount) * 100));
    return `
      <div class="ranking-item">
        <span class="rank-num ${rankClass}">${rank}</span>
        <div class="ranking-item-body">
          <div class="ranking-item-bar" style="width:${barWidth}%"></div>
          <div class="ranking-item-info">
            <span class="ranking-item-title">${escapeHtml(item.title)}</span>
            <span class="ranking-item-artist">${escapeHtml(item.artist)}</span>
          </div>
        </div>
        <span class="ranking-count">${item.count}<span class="ranking-count-unit">回</span></span>
      </div>`;
  }).join("");
}

/** お気に入りフィルターの状態（true = ⭐のみ表示） */
let historyShowStarredOnly = false;

/**
 * 指定 id の starred フラグをトグルして IndexedDB を更新する。
 * @param {number} id
 */
function toggleStarred(id) {
  if (!db) return;
  const tx  = db.transaction(STORE, "readwrite");
  const req = tx.objectStore(STORE).get(id);
  req.onsuccess = () => {
    const item = req.result;
    if (!item) return;
    item.starred = !item.starred;
    tx.objectStore(STORE).put(item);
    // ボタンの見た目だけ即時更新（再レンダリングより軽量）
    const btn = document.querySelector(`.history-star-btn[data-id="${id}"]`);
    if (btn) {
      btn.textContent = item.starred ? "⭐" : "☆";
      btn.classList.toggle("starred", item.starred);
      btn.title = item.starred ? "お気に入り解除" : "お気に入りに追加";
    }
  };
}

function loadHistory(searchTerm = "") {
  if (!historyArea || !db) return;
  historyArea.innerHTML = "";

  // 詳細フィルター値を取得
  const dateFrom   = document.getElementById("filterDateFrom")?.value  || "";
  const dateTo     = document.getElementById("filterDateTo")?.value    || "";
  const confMin    = parseInt(document.getElementById("filterConfMin")?.value || "0", 10);
  const dateFromMs = dateFrom ? new Date(dateFrom).getTime()                          : 0;
  const dateToMs   = dateTo   ? new Date(dateTo + "T23:59:59").getTime()              : Infinity;

  const tx    = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const items = [];

  store.openCursor(null, "prev").onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) {
      const item = cursor.value;
      // ⭐フィルター
      if (historyShowStarredOnly && !item.starred) { cursor.continue(); return; }
      // テキスト検索
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        if (!item.title?.toLowerCase().includes(s) && !item.artist?.toLowerCase().includes(s)) {
          cursor.continue(); return;
        }
      }
      // 日付フィルター
      if (item.time < dateFromMs || item.time > dateToMs) { cursor.continue(); return; }
      // 信頼度フィルター
      if ((item.confidence ?? 0) < confMin) { cursor.continue(); return; }

      items.push(item);
      cursor.continue();
    } else {
      displayHistoryItems(items);
      loadAndRenderStats();
      _updateStarBadge();
    }
  };
}

/** お気に入りフィルターボタンのバッジ（件数）を更新する。 */
function _updateStarBadge() {
  if (!db) return;
  const tx = db.transaction(STORE, "readonly");
  let count = 0;
  tx.objectStore(STORE).openCursor().onsuccess = e => {
    const c = e.target.result;
    if (c) { if (c.value.starred) count++; c.continue(); }
    else {
      const badge = document.getElementById("starBadge");
      if (badge) {
        badge.textContent = count > 0 ? count : "";
        badge.style.display = count > 0 ? "inline" : "none";
      }
    }
  };
}

function displayHistoryItems(items) {
  if (items.length === 0) {
    historyArea.innerHTML = `<div style="text-align:center;color:#94a3b8;padding:20px;">${historyShowStarredOnly ? "⭐ お気に入りがありません" : "履歴がありません"}</div>`;
    return;
  }

  items.forEach(item => {
    const date    = new Date(item.time);
    const dateStr = date.toLocaleString("ja-JP");

    const itemDiv = document.createElement("div");
    itemDiv.className = "history-item";
    itemDiv.dataset.id = item.id;

    const infoDiv = document.createElement("div");
    infoDiv.className = "history-item-info";
    infoDiv.innerHTML = `
      <div class="history-item-title">${escapeHtml(item.title)}</div>
      <div class="history-item-artist">${escapeHtml(item.artist)}</div>
      <div class="history-item-meta">📅 ${dateStr} • 🎯 ${item.confidence}%</div>
    `;
    infoDiv.onclick = () => loadHistoryItem(item.id);

    // ⭐ お気に入りボタン
    const starBtn = document.createElement("button");
    starBtn.className = "history-star-btn" + (item.starred ? " starred" : "");
    starBtn.dataset.id = item.id;
    starBtn.textContent = item.starred ? "⭐" : "☆";
    starBtn.title = item.starred ? "お気に入り解除" : "お気に入りに追加";
    starBtn.onclick = e => { e.stopPropagation(); toggleStarred(item.id); };

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "history-item-delete";
    deleteBtn.textContent = "削除";
    deleteBtn.onclick = e => { e.stopPropagation(); deleteHistoryItem(item.id); };

    itemDiv.appendChild(infoDiv);
    itemDiv.appendChild(starBtn);
    itemDiv.appendChild(deleteBtn);
    historyArea.appendChild(itemDiv);
  });
}

function loadHistoryItem(id) {
  if (!db) return;

  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).get(id);

  req.onsuccess = () => {
    const item = req.result;
    if (!item) return;

    currentTrackInfo = { title: item.title, artist: item.artist, albumArt: '', album: '' };

    // previewSection をリセット
    const prevSection = document.getElementById('previewSection');
    if (prevSection) prevSection.style.display = 'none';
    const spContent = document.getElementById('spotifyContent');
    if (spContent) spContent.innerHTML = '';
    const itContent = document.getElementById('itunesPreviewContent');
    if (itContent) itContent.innerHTML = '';

    // YouTube エリアをリセット
    if (typeof resetYouTube === 'function') resetYouTube();

    // resultArea に「履歴から復元」カードを描画
    const dateStr = item.time ? new Date(item.time).toLocaleString('ja-JP') : '';
    resultArea.innerHTML = `
      <div class="card history-restored-card">
        <div class="history-restored-header">
          <span class="history-restored-badge">📜 履歴から復元</span>
          <span class="history-restored-date">${dateStr}</span>
        </div>
        <div class="history-restored-title">${escapeHtml(item.title)}</div>
        <div class="history-restored-artist">🎤 ${escapeHtml(item.artist)}</div>
        <div class="history-restored-meta">信頼度: ${item.confidence}%</div>
        <div class="stream-links" id="history-stream-links"></div>
        <button class="share-card-btn" onclick="openShareCardModal()">🖼️ シェアカードを作成</button>
      </div>
    `;

    // ストリーミングリンクを生成（Spotify/Deezer track ID は不明なのでフォールバック検索URL）
    buildStreamingLinks(item.title, item.artist, 'history-stream-links', {});

    // API 再フェッチ
    fetchMusicBrainz(item.title, item.artist).catch(e => console.error('MusicBrainz:', e));
    fetchItunesArtwork(item.title, item.artist).then(itunesData => {
      if (!itunesData) return;
      currentTrackInfo.albumArt   = itunesData.url600 || '';
      currentTrackInfo.itunesData = itunesData;
      // Apple Music リンク差し替え
      if (itunesData.trackViewUrl) {
        const amLink = resultArea.querySelector('.stream-apple');
        if (amLink) {
          amLink.href  = itunesData.trackViewUrl;
          amLink.title = 'Apple Music で開く（直接リンク）';
          amLink.classList.add('stream-apple-direct');
        }
      }
      showItunesPreview(itunesData);
      updateMBiTunesSection(itunesData);
    }).catch(e => console.error('iTunes:', e));

    // Spotify embed は track ID 不明のためスキップ（MusicBrainz 後に再試行）
    showSpotifyEmbed(null);

    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('履歴から復元しました', 'success');
  };
}

function deleteHistoryItem(id) {
  if (!db) return;
  if (!confirm('この履歴を削除しますか？')) return;
  
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  tx.oncomplete = () => {
    if (historySearch) loadHistory(historySearch.value);
    showToast('履歴を削除しました', 'success');
  };
}

function clearAllHistory() {
  if (!db) return;
  if (!confirm('全ての履歴を削除しますか？この操作は取り消せません。')) return;
  
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  tx.oncomplete = () => {
    loadHistory();
    showToast('全ての履歴を削除しました', 'success');
  };
}

/**
 * 認識履歴を CSV ファイルとしてエクスポートする。
/**
 * エクスポートモーダルを開く。CSV / JSON 選択とお気に入りのみオプションを提供。
 */
function openExportModal() {
  const modal = document.getElementById("exportModal");
  if (!modal) return;
  // 件数を更新してから開く
  _updateExportCount();
  modal.classList.add("is-open");
}

/** エクスポートモーダルを閉じる。 */
function closeExportModal() {
  const modal = document.getElementById("exportModal");
  if (modal) modal.classList.remove("is-open");
}

/** エクスポートモーダル内の件数表示を更新する。 */
function _updateExportCount() {
  if (!db) return;
  const tx = db.transaction(STORE, "readonly");
  let total = 0, starred = 0;
  tx.objectStore(STORE).openCursor().onsuccess = e => {
    const c = e.target.result;
    if (c) { total++; if (c.value.starred) starred++; c.continue(); }
    else {
      const totalEl   = document.getElementById("exportCountTotal");
      const starredEl = document.getElementById("exportCountStarred");
      if (totalEl)   totalEl.textContent   = total;
      if (starredEl) starredEl.textContent = starred;
    }
  };
}

/**
 * 選択されたフォーマット・オプションでエクスポートを実行する。
 * モーダルの「エクスポート」ボタンから呼ばれる。
 */
function executeExport() {
  if (!db) return;
  const fmt        = document.querySelector('input[name="exportFmt"]:checked')?.value || "csv";
  const starredOnly = document.getElementById("exportStarredOnly")?.checked || false;

  const tx = db.transaction(STORE, "readonly");
  const items = [];
  tx.objectStore(STORE).openCursor(null, "prev").onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) {
      if (!starredOnly || cursor.value.starred) items.push(cursor.value);
      cursor.continue();
    } else {
      if (fmt === "json") {
        _exportAsJson(items);
      } else {
        _exportAsCsv(items);
      }
      closeExportModal();
    }
  };
}

/**
 * 履歴アイテム配列を JSON ファイルとしてダウンロードする。
 * @param {Array} items
 */
function _exportAsJson(items) {
  const data = items.map(it => ({
    id:         it.id,
    title:      it.title  || "",
    artist:     it.artist || "",
    confidence: it.confidence ?? 0,
    time:       new Date(it.time).toISOString(),
    starred:    !!it.starred
  }));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `music-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`${items.length} 件を JSON でエクスポートしました`, "success");
}

/**
 * 履歴アイテム配列を CSV ファイルとしてダウンロードする。
 * 列: 番号, 曲名, アーティスト, 信頼度(%), 認識日時(JST), お気に入り
 * BOM 付き UTF-8 で出力するため Excel でも文字化けしない。
 * @param {Array} items
 */
function _exportAsCsv(items) {
  const header = ["番号", "曲名", "アーティスト", "信頼度(%)", "認識日時(JST)", "お気に入り"];
  const rows   = items.map(it => {
    const d   = new Date(it.time);
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = jst.toISOString().replace("T", " ").slice(0, 19);
    return [
      it.id,
      `"${(it.title  || "").replace(/"/g, '""')}"`,
      `"${(it.artist || "").replace(/"/g, '""')}"`,
      it.confidence ?? 0,
      dateStr,
      it.starred ? "⭐" : ""
    ].join(",");
  });
  const csv  = [header.join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `music-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`${items.length} 件を CSV でエクスポートしました`, "success");
}

/* ========= ⑦ 履歴統計ダッシュボード ========= */

function initStatsPanel() {
  const panel  = document.getElementById('statsPanel');
  const toggle = document.getElementById('statsToggle');
  const body   = document.getElementById('statsBody');
  const icon   = document.getElementById('statsToggleIcon');
  if (!panel || !toggle) return;

  toggle.addEventListener('click', () => {
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    icon.textContent   = open ? '▶' : '▼';
  });
}

function calcHistoryStats(allItems) {
  const total = allItems.length;

  // アーティスト別集計
  const artistMap = {};
  allItems.forEach(item => {
    const a = item.artist || '不明';
    artistMap[a] = (artistMap[a] || 0) + 1;
  });
  const topArtists = Object.entries(artistMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // 時間帯別集計（0〜23時）
  const byHour = Array(24).fill(0);
  allItems.forEach(item => {
    const h = new Date(item.time).getHours();
    byHour[h]++;
  });

  // 直近7日間の日別集計
  const now   = Date.now();
  const byDay = Array(7).fill(0);
  const dayLabels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    dayLabels.push(`${d.getMonth()+1}/${d.getDate()}`);
  }
  allItems.forEach(item => {
    const diffDays = Math.floor((now - item.time) / 86400000);
    if (diffDays >= 0 && diffDays < 7) {
      byDay[6 - diffDays]++;
    }
  });

  return { total, topArtists, byHour, byDay, dayLabels };
}

function renderStats(stats) {
  const panel = document.getElementById('statsPanel');
  if (!panel) return;
  panel.style.display = stats.total === 0 ? 'none' : 'block';
  if (stats.total === 0) return;

  // サマリー
  const summary = document.getElementById('statsSummary');
  if (summary) {
    summary.innerHTML = `<span class="stats-total">総認識数 <b>${stats.total}</b> 件</span>`;
  }

  const isDark = document.body.classList.contains('dark');
  const textColor  = isDark ? '#cbd5e1' : '#475569';
  const gridColor  = isDark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)';
  const accentA    = isDark ? '#818cf8' : '#4f46e5';
  const accentB    = isDark ? '#34d399' : '#10b981';

  // ① アーティストTOP5 横棒グラフ
  const ca = document.getElementById('chartArtist');
  if (ca && stats.topArtists.length > 0) {
    drawHorizBarChart(ca, stats.topArtists.map(x=>x[0]), stats.topArtists.map(x=>x[1]),
      { barColor: accentA, textColor, gridColor });
  }

  // ② 時間帯別 縦棒グラフ
  const ch = document.getElementById('chartHour');
  if (ch) {
    const labels = Array.from({length:24}, (_,i)=> i%6===0 ? `${i}時` : '');
    drawVertBarChart(ch, labels, stats.byHour,
      { barColor: accentB, textColor, gridColor });
  }

  // ③ 直近7日 折れ線グラフ
  const cw = document.getElementById('chartWeek');
  if (cw) {
    drawLineChart(cw, stats.dayLabels, stats.byDay,
      { lineColor: accentA, fillColor: accentA + '33', textColor, gridColor });
  }
}

/* --- グラフ描画ユーティリティ --- */
function _initCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth  || 300;
  const H   = canvas.offsetHeight || 120;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, W, H };
}

function drawHorizBarChart(canvas, labels, values, opts) {
  const { ctx, W, H } = _initCanvas(canvas);
  const maxV  = Math.max(...values, 1);
  const rowH  = H / labels.length;
  const padL  = 110, padR = 36, padT = 8, padB = 8;
  const barAreaW = W - padL - padR;

  ctx.clearRect(0, 0, W, H);

  labels.forEach((label, i) => {
    const y      = padT + i * rowH;
    const barW   = (values[i] / maxV) * barAreaW;
    const barY   = y + rowH * 0.2;
    const barH2  = rowH * 0.6;

    // バー
    ctx.fillStyle = opts.barColor;
    ctx.beginPath();
    ctx.roundRect(padL, barY, Math.max(barW, 2), barH2, 3);
    ctx.fill();

    // ラベル（左）
    ctx.fillStyle = opts.textColor;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const shortLabel = label.length > 12 ? label.slice(0, 11) + '…' : label;
    ctx.fillText(shortLabel, padL - 8, barY + barH2/2);

    // 値（右）
    ctx.textAlign = 'left';
    ctx.fillText(values[i], padL + barW + 5, barY + barH2/2);
  });
}

function drawVertBarChart(canvas, labels, values, opts) {
  const { ctx, W, H } = _initCanvas(canvas);
  const maxV  = Math.max(...values, 1);
  const padL  = 28, padR = 8, padT = 12, padB = 20;
  const areaW = W - padL - padR;
  const areaH = H - padT - padB;
  const barW  = areaW / values.length;

  ctx.clearRect(0, 0, W, H);

  // グリッド線（横3本）
  ctx.strokeStyle = opts.gridColor;
  ctx.lineWidth = 1;
  for (let g = 1; g <= 3; g++) {
    const gy = padT + areaH * (1 - g/4);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
  }

  values.forEach((v, i) => {
    const x    = padL + i * barW;
    const barH2 = (v / maxV) * areaH;
    ctx.fillStyle = opts.barColor;
    ctx.beginPath();
    ctx.roundRect(x + barW*0.1, padT + areaH - barH2, barW*0.8, Math.max(barH2, 1), 2);
    ctx.fill();

    // ラベル
    if (labels[i]) {
      ctx.fillStyle = opts.textColor;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(labels[i], x + barW/2, H - padB + 3);
    }
  });
}

function drawLineChart(canvas, labels, values, opts) {
  const { ctx, W, H } = _initCanvas(canvas);
  const maxV  = Math.max(...values, 1);
  const padL  = 28, padR = 12, padT = 12, padB = 22;
  const areaW = W - padL - padR;
  const areaH = H - padT - padB;
  const step  = areaW / (values.length - 1 || 1);

  ctx.clearRect(0, 0, W, H);

  // グリッド線
  ctx.strokeStyle = opts.gridColor;
  ctx.lineWidth = 1;
  for (let g = 1; g <= 3; g++) {
    const gy = padT + areaH * (1 - g/4);
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
  }

  const pts = values.map((v, i) => ({
    x: padL + i * step,
    y: padT + areaH * (1 - v / maxV)
  }));

  // 塗りつぶし
  ctx.beginPath();
  ctx.moveTo(pts[0].x, padT + areaH);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length-1].x, padT + areaH);
  ctx.closePath();
  ctx.fillStyle = opts.fillColor;
  ctx.fill();

  // 折れ線
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = opts.lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 点 + ラベル
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = opts.lineColor;
    ctx.fill();
    ctx.fillStyle = opts.textColor;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(labels[i], p.x, H - padB + 4);
    if (values[i] > 0) {
      ctx.textBaseline = 'bottom';
      ctx.fillText(values[i], p.x, p.y - 4);
    }
  });
}

function loadAndRenderStats() {
  if (!db) return;
  const tx    = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const items = [];
  store.openCursor().onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) { items.push(cursor.value); cursor.continue(); }
    else { renderStats(calcHistoryStats(items)); }
  };
}

/* ========= ⑧ シェアカード生成 ========= */

/* ========= フォーマット選択（ピルボタン） ========= */
let _shareCardFmt = 'png';  // モジュールレベルで保持

function setShareFormat(btn, fmt) {
  _shareCardFmt = fmt;
  // ピルのアクティブ状態を切り替え
  btn.closest('.fmt-pill-group').querySelectorAll('.fmt-pill').forEach(b => {
    b.classList.toggle('fmt-pill--active', b === btn);
  });
  // キャンバスを再描画（最後に渡した cardData を再利用）
  const canvas = document.getElementById('shareCardCanvas');
  if (canvas && canvas._cardData) {
    generateShareCard(canvas, canvas._cardData);
  }
}

function openShareCardModal(cardDiv) {
  const modal = document.getElementById('shareCardModal');
  if (!modal) return;

  const title   = cardDiv?.dataset.title  || currentTrackInfo?.title  || '不明';
  const artist  = cardDiv?.dataset.artist || currentTrackInfo?.artist || '不明';
  const album   = cardDiv?.dataset.album  || currentTrackInfo?.album  || '';
  const img     = cardDiv?.querySelector('.album-art');
  const artSrc  = img?.src || currentTrackInfo?.albumArt || '';

  // 追加情報（currentTrackInfo から）
  const releaseDate = currentTrackInfo?.releaseDate || '';
  const durationMs  = currentTrackInfo?.durationMs  || 0;
  const isrc        = currentTrackInfo?.isrc        || '';
  const genre       = currentTrackInfo?.genre       || '';
  const spotifyUrl  = currentTrackInfo?.spotifyUrl  || '';

  const canvas  = document.getElementById('shareCardCanvas');
  if (!canvas) return;

  const cardData = { title, artist, album, artSrc, releaseDate, durationMs, isrc, genre, spotifyUrl };
  canvas._cardData = cardData;  // setShareFormatから再描画できるよう保持

  generateShareCard(canvas, cardData).then(() => {
    modal.classList.add('is-open');

    const dlBtn = document.getElementById('shareCardDownload');
    if (dlBtn) {
      dlBtn.onclick = () => {
        const fmt  = _shareCardFmt;
        const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
        const ext  = fmt === 'jpeg' ? 'jpg' : 'png';
        const a = document.createElement('a');
        a.href     = canvas.toDataURL(mime, 0.95);
        a.download = `share_${title.replace(/[^a-zA-Z0-9]/g,'_')}.${ext}`;
        a.click();
      };
    }

    const shBtn = document.getElementById('shareCardShare');
    if (shBtn) {
      if (navigator.canShare) {
        shBtn.style.display = '';
        shBtn.onclick = async () => {
          const fmt  = _shareCardFmt;
          const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
          canvas.toBlob(async blob => {
            try {
              const file = new File([blob], `share_card.${fmt}`, { type: mime });
              if (navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title, text: `${title} / ${artist}` });
              } else {
                await navigator.share({ title, text: `${title} / ${artist}` });
              }
            } catch {}
          }, mime, 0.95);
        };
      } else {
        shBtn.style.display = 'none';
      }
    }
  });
}

function closeShareCardModal() {
  const modal = document.getElementById('shareCardModal');
  if (modal) modal.classList.remove('is-open');
}

async function generateShareCard(canvas, { title, artist, album, artSrc, releaseDate, durationMs, isrc, genre, spotifyUrl }) {
  const W = 640, H = 340;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const isDark = document.body.classList.contains('dark');

  // ── 背景 ──
  if (artSrc) {
    await new Promise(resolve => {
      const bg = new Image();
      bg.crossOrigin = 'anonymous';
      bg.onload = () => {
        ctx.filter = 'blur(20px) brightness(0.4)';
        const scale = Math.max(W / bg.width, H / bg.height);
        const sw    = bg.width * scale, sh = bg.height * scale;
        ctx.drawImage(bg, (W-sw)/2, (H-sh)/2, sw, sh);
        ctx.filter = 'none';
        resolve();
      };
      bg.onerror = () => resolve();
      bg.src = artSrc;
    });
    ctx.fillStyle = isDark ? 'rgba(0,0,0,.58)' : 'rgba(0,0,0,.48)';
    ctx.fillRect(0, 0, W, H);
  } else {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, isDark ? '#1e1b4b' : '#3730a3');
    grad.addColorStop(1, isDark ? '#134e4a' : '#0f766e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  const PAD   = 28;
  const ART_S = 140;
  const artX  = PAD, artY  = (H - ART_S) / 2;

  // ── アルバムアート ──
  if (artSrc) {
    await new Promise(resolve => {
      const artImg = new Image();
      artImg.crossOrigin = 'anonymous';
      artImg.onload = () => {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(artX, artY, ART_S, ART_S, 12);
        ctx.clip();
        ctx.drawImage(artImg, artX, artY, ART_S, ART_S);
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,.28)';
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.roundRect(artX, artY, ART_S, ART_S, 12);
        ctx.stroke();
        resolve();
      };
      artImg.onerror = () => {
        ctx.fillStyle = 'rgba(255,255,255,.12)';
        ctx.beginPath(); ctx.roundRect(artX, artY, ART_S, ART_S, 12); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.font = '52px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🎵', artX + ART_S/2, artY + ART_S/2);
        resolve();
      };
      artImg.src = artSrc;
    });
  } else {
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.roundRect(artX, artY, ART_S, ART_S, 12); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '52px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🎵', artX + ART_S/2, artY + ART_S/2);
  }

  // ── テキスト列 ──
  const textX = artX + ART_S + PAD;
  const textW = W - textX - PAD;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor  = 'rgba(0,0,0,.65)';
  ctx.shadowBlur   = 7;

  // タイトル
  ctx.font      = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(_fitText(ctx, title, textW), textX, artY + 32);

  // アーティスト
  ctx.font      = '17px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.88)';
  ctx.fillText(_fitText(ctx, `🎤 ${artist}`, textW), textX, artY + 60);

  // アルバム
  let metaY = artY + 90;
  if (album) {
    ctx.font      = '14px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText(_fitText(ctx, `💿 ${album}`, textW), textX, metaY);
    metaY += 24;
  }

  // リリース日 / 時間
  const parts = [];
  if (releaseDate) parts.push(`📅 ${releaseDate}`);
  if (durationMs)  parts.push(`⏱ ${formatDuration(durationMs)}`);
  if (parts.length) {
    ctx.font      = '13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.65)';
    ctx.fillText(_fitText(ctx, parts.join('  '), textW), textX, metaY);
    metaY += 22;
  }

  // ジャンル
  if (genre) {
    ctx.font      = '12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.fillText(_fitText(ctx, `🎼 ${genre}`, textW), textX, metaY);
    metaY += 20;
  }

  // ISRC
  if (isrc) {
    ctx.font      = '11px SFMono-Regular, Consolas, monospace';
    ctx.fillStyle = 'rgba(255,255,255,.45)';
    ctx.fillText(`ISRC: ${isrc}`, textX, metaY);
  }

  // 区切り線
  ctx.shadowBlur  = 0;
  const lineY = H - 46;
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, lineY);
  ctx.lineTo(W - PAD, lineY);
  ctx.stroke();

  // ── フッター ──
  ctx.font      = '12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.textAlign = 'left';
  ctx.fillText(`🎵 Trackora`, PAD, H - 18);
  ctx.textAlign = 'right';
  ctx.fillText(`v${APP_VERSION}  ${new Date().toLocaleDateString('ja-JP')}`, W - PAD, H - 18);
}

function _fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0,-1);
  return t + '…';
}

/* ========= マイク列挙 ========= */
async function enumerateMicrophones() {
  if (!micSelect) return;
  
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter(d => d.kind === 'audioinput');
    
    micSelect.innerHTML = '<option value="">デフォルト</option>';
    
    audioDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `マイク ${index + 1}`;
      micSelect.appendChild(option);
    });
    
  } catch (err) {
    console.error('マイク列挙エラー:', err);
  }
}

/* ========= ⑥ 録音波形ビジュアライザー ========= */
let _vizAudioCtx = null;
let _vizAnalyser = null;
let _vizAnimId   = null;
let _vizTotalSec = 0;
let _vizElapsed  = 0;
let _vizTimerViz = null;

function startVisualizer(stream, totalSec) {
  const canvas   = document.getElementById('vizCanvas');
  const container = document.getElementById('vizContainer');
  const progBar  = document.getElementById('vizProgressBar');
  if (!canvas || !container) return;

  container.style.display = 'block';
  _vizTotalSec = totalSec;
  _vizElapsed  = 0;

  // AudioContext & Analyser
  _vizAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  _vizAnalyser = _vizAudioCtx.createAnalyser();
  _vizAnalyser.fftSize = 256;
  const source = _vizAudioCtx.createMediaStreamSource(stream);
  source.connect(_vizAnalyser);

  const bufLen  = _vizAnalyser.frequencyBinCount; // 128
  const dataArr = new Uint8Array(bufLen);
  const ctx     = canvas.getContext('2d');

  // Canvasサイズをコンテナに合わせる
  const resize = () => {
    canvas.width  = canvas.offsetWidth  * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  };
  resize();

  const isDark  = document.body.classList.contains('dark');
  const C1 = isDark ? '#818cf8' : '#4f46e5';
  const C2 = isDark ? '#67e8f9' : '#06b6d4';

  function draw() {
    _vizAnimId = requestAnimationFrame(draw);
    _vizAnalyser.getByteFrequencyData(dataArr);

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    ctx.clearRect(0, 0, W, H);

    const barW = (W / bufLen) * 2;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const barH = (dataArr[i] / 255) * H * 0.9;
      const ratio = i / bufLen;
      // グラデーション補間
      const r1 = parseInt(C1.slice(1,3),16), g1 = parseInt(C1.slice(3,5),16), b1 = parseInt(C1.slice(5,7),16);
      const r2 = parseInt(C2.slice(1,3),16), g2 = parseInt(C2.slice(3,5),16), b2 = parseInt(C2.slice(5,7),16);
      const r = Math.round(r1 + (r2-r1)*ratio);
      const g = Math.round(g1 + (g2-g1)*ratio);
      const b = Math.round(b1 + (b2-b1)*ratio);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.roundRect(x, H - barH, barW - 2, barH, 2);
      ctx.fill();
      x += barW;
    }
  }
  draw();

  // プログレスバー更新
  if (progBar) {
    _vizTimerViz = setInterval(() => {
      _vizElapsed++;
      const pct = Math.min((_vizElapsed / _vizTotalSec) * 100, 100);
      progBar.style.width = pct + '%';
    }, 1000);
  }
}

function stopVisualizer() {
  if (_vizAnimId) { cancelAnimationFrame(_vizAnimId); _vizAnimId = null; }
  if (_vizTimerViz) { clearInterval(_vizTimerViz); _vizTimerViz = null; }
  if (_vizAudioCtx) { _vizAudioCtx.close(); _vizAudioCtx = null; }
  _vizAnalyser = null;

  const container = document.getElementById('vizContainer');
  const canvas    = document.getElementById('vizCanvas');
  const progBar   = document.getElementById('vizProgressBar');
  if (container) container.style.display = 'none';
  if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height); }
  if (progBar) progBar.style.width = '0%';
}

/* ========= 録音機能 ========= */
let recorder, chunks = [], timer, remain, currentStream;

function setupRecordingHandlers() {
  if (!recBtn || !stopBtn) return;
  
  recBtn.addEventListener('click', async () => {
    try {
      const sec = Number(recSec.value);
      const deviceId = micSelect.value;
      
      const constraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      };
      
      currentStream = await navigator.mediaDevices.getUserMedia(constraints);
      recorder = new MediaRecorder(currentStream);
      chunks = [];

      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.start();

      remain = sec;
      counter.textContent = `🎙️ 録音中: ${remain}秒`;

      // ⑥ 波形ビジュアライザー開始
      startVisualizer(currentStream, sec);

      recBtn.disabled = true;
      stopBtn.disabled = false;

      timer = setInterval(() => {
        remain--;
        counter.textContent = `🎙️ 録音中: ${remain}秒`;
        if (remain <= 0) stopRec();
      }, 1000);
    } catch (err) {
      alert('マイクへのアクセスが拒否されました');
      console.error(err);
      showToast('マイクアクセスエラー', 'error');
    }
  });

  stopBtn.addEventListener('click', stopRec);

  if (sendRecordBtn) {
    sendRecordBtn.addEventListener('click', () => {
      if (currentRecordedBlob) {
        send(new File([currentRecordedBlob], "record.webm", { type: "audio/webm" }));
        recordPreview.style.display = "none";
        sendRecordBtn.style.display = "none";
      }
    });
  }
}

function stopRec() {
  if (!recorder) return;
  clearInterval(timer);
  recorder.stop();
  // ⑥ ビジュアライザー停止
  stopVisualizer();
  
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: "audio/webm" });
    currentRecordedBlob = blob;
    
    const url = URL.createObjectURL(blob);
    recordPreview.src = url;
    recordPreview.style.display = "block";
    sendRecordBtn.style.display = "inline-block";
    
    counter.textContent = "✅ 録音完了。プレビューを確認して判定してください。";
    
    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
    }
    
    showToast('録音が完了しました', 'success');
  };
  
  recBtn.disabled = false;
  stopBtn.disabled = true;
}

/* ========= ⑨ キーボードショートカット ========= */

function openShortcutPanel() {
  const panel = document.getElementById('shortcutPanel');
  if (panel) panel.classList.add('is-open');
}

function closeShortcutPanel() {
  const panel = document.getElementById('shortcutPanel');
  if (panel) panel.classList.remove('is-open');
}

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // テキスト入力中・修飾キー（Ctrl/Meta/Alt）は無視
    const tag = document.activeElement?.tagName;
    const isInputActive = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);

    // Escキーはどこでも有効（パネルを閉じる）
    if (e.key === 'Escape') {
      closeShortcutPanel();
      closeShareCardModal();
      closeCloudSyncModal();
      closeExportModal();
      closeExportModal();
      return;
    }

    // ? キーはどこでも有効（ヘルプ表示）
    if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
      const panel = document.getElementById('shortcutPanel');
      if (panel) {
        panel.classList.toggle('is-open');
      }
      return;
    }

    // テキスト入力中は残りのショートカットを無効化
    if (isInputActive || e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key.toLowerCase()) {
      case 'r': {
        // 録音開始 / 停止トグル
        e.preventDefault();
        if (recBtn && !recBtn.disabled) {
          recBtn.click();
        } else if (stopBtn && !stopBtn.disabled) {
          stopBtn.click();
        }
        break;
      }
      case ' ': {
        // YouTube 再生 / 一時停止
        e.preventDefault();
        if (window._ytPlayer && typeof window._ytPlayer.getPlayerState === 'function') {
          const state = window._ytPlayer.getPlayerState();
          // 1=playing, 2=paused
          if (state === 1) window._ytPlayer.pauseVideo();
          else             window._ytPlayer.playVideo();
        }
        break;
      }
      case 'c': {
        // アクティブ候補の曲情報をコピー
        e.preventDefault();
        const activeCard = document.querySelector('.candidate-card.candidate-active');
        if (activeCard) {
          const copyBtn = activeCard.querySelector('.stream-copy');
          if (copyBtn) copyBtn.click();
        }
        break;
      }
      case 'd': {
        // ダークモード切替
        e.preventDefault();
        toggleTheme();
        break;
      }
    }
  });
}

/* ========= テーマ切り替え ========= */
let currentTheme = localStorage.getItem('theme') || 'light';

function initTheme() {
  applyTheme(currentTheme);
}

function toggleTheme() {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(currentTheme);
  localStorage.setItem('theme', currentTheme);
  showToast(`${currentTheme === 'dark' ? '🌙 ダーク' : '☀️ ライト'}モードに変更しました`, 'success');
}

function applyTheme(theme) {
  // CSS変数オーバーライド方式: body.dark クラスの付け外しだけで全要素が切り替わる
  if (theme === 'dark') {
    document.body.classList.add('dark');
    document.querySelector('.theme-toggle').textContent = '☀️';
  } else {
    document.body.classList.remove('dark');
    document.querySelector('.theme-toggle').textContent = '🌙';
  }
  // ① Spotify埋め込みのテーマを再適用（ダーク: theme=0 を付加）
  const spIframe = document.querySelector('#spotifyContent iframe');
  if (spIframe) {
    try {
      const base = spIframe.src.replace(/[&?]theme=\d/, '');
      spIframe.src = theme === 'dark' ? base + '&theme=0' : base;
    } catch(_) {}
  }
}

/* ========= iTunes Search API でアートワーク取得 ========= */
async function fetchItunesArtwork(title, artist) {
  const cached = _cacheGet("itunes", title, artist);
  if (cached) { debugLog("Apple Music: キャッシュ使用", { title, artist }); return cached; }

  debugLog("Apple Music: Workerへ送信", { title, artist, endpoint: `${WORKER_URL}itunes` });
  const itunesT0 = Date.now();

  try {
    const res = await fetch(`${WORKER_URL}itunes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist })
    });
    const itunesDuration = Date.now() - itunesT0;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    debugLog("Apple Music: Workerレスポンス受信", {
      http_status: res.status,
      success: json.success,
      duration_ms: itunesDuration,
      result_count: json.results?.length ?? 0,
      bestMatch: json.bestMatch ?? null,
      results_top3: json.results?.slice(0, 3) ?? [],
      error: json.error ?? null
    }, { duration_ms: itunesDuration, status: json.success ? "ok" : "warn" });
    debugLogWorker("Apple Music", json, res.status);

    if (!json.success || !json.bestMatch) return null;

    const match = json.bestMatch;
    const result = {
      url100: match.artworkUrl100,
      url600: match.artworkUrl600,
      url1200: match.artworkUrl1200,
      trackName: match.trackName,
      artistName: match.artistName,
      albumName: match.collectionName,
      previewUrl: match.previewUrl,
      trackViewUrl: match.trackViewUrl,
      durationMs: match.trackTimeMillis || 0
    };
    _cacheSet("itunes", title, artist, result);
    return result;

  } catch (error) {
    debugLog("Apple Music: エラー", { message: error.message }, { status: "error", duration_ms: Date.now() - itunesT0 });
    return null;
  }
}

/* ========= ① Spotify 埋め込みプレーヤー ========= */

/* previewSectionの表示を統括 */
function showPreviewSection() {
  const section = document.getElementById('previewSection');
  if (!section) return;
  const spEl = document.getElementById('spotifyContent');
  const itEl = document.getElementById('itunesPreviewContent');
  const hasContent = (spEl && spEl.innerHTML.trim() !== '') ||
                     (itEl && itEl.innerHTML.trim() !== '');
  section.style.display = hasContent ? 'block' : 'none';
}

function showSpotifyEmbed(trackId) {
  const content = document.getElementById('spotifyContent');
  if (!content) return;

  if (!trackId) {
    content.innerHTML = '';
    debugLog('Spotify: track ID なし — 埋め込みスキップ', { track_id: null });
    showPreviewSection();
    return;
  }

  const isDark = document.body.classList.contains('dark');
  const theme  = isDark ? '&theme=0' : '';
  const src    = `https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}?utm_source=generator${theme}`;

  content.innerHTML = `
    <div class="spotify-embed-wrap">
      <iframe
        src="${src}"
        width="100%"
        height="152"
        frameborder="0"
        allowtransparency="true"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
        title="Spotify プレーヤー">
      </iframe>
      <div class="spotify-embed-note">
        <a href="https://open.spotify.com/track/${encodeURIComponent(trackId)}" target="_blank" class="spotify-open-link">
          🎵 Spotify で開く
        </a>
        <span class="spotify-preview-note">Spotifyアカウントで全曲再生可能</span>
      </div>
    </div>`;

  debugLog('Spotify: 埋め込み表示', { track_id: trackId, src });
  showPreviewSection();
}

/* ========= Spotify Web API トラック情報取得 ========= */
/**
 * Spotify API からトラック情報を取得する。
 * Worker の /spotify エンドポイントを経由してアクセストークンを管理する。
 *
 * @param {string} title   曲タイトル
 * @param {string} artist  アーティスト名
 * @param {string|null} trackId  Spotify Track ID（ACRCloud から取得済みの場合）
 */
async function fetchSpotifyTrackInfo(title, artist, trackId = null) {
  const cached = _cacheGet("spotify", title, artist);
  if (cached) { debugLog("Spotify: キャッシュ使用", { title, artist }); return cached; }

  debugLog("Spotify: Workerへ送信", { title, artist, track_id: trackId, endpoint: `${WORKER_URL}spotify` });
  const t0 = Date.now();

  try {
    const res = await fetch(`${WORKER_URL}spotify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist, track_id: trackId })
    });
    const duration = Date.now() - t0;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    debugLog("Spotify: Workerレスポンス受信", {
      success: json.success,
      duration_ms: duration,
      track_id: json.track?.id ?? null,
      preview_url: json.track?.preview_url ?? null,
      popularity: json.track?.popularity ?? null,
      error: json.error ?? null
    }, { duration_ms: duration, status: json.success ? "ok" : "warn" });
    debugLogWorker("Spotify", json, res.status);

    if (!json.success || !json.track) return null;

    const t = json.track;
    // currentTrackInfo に Spotify 詳細を補完
    if (currentTrackInfo) {
      if (!currentTrackInfo.durationMs && t.duration_ms)
        currentTrackInfo.durationMs = t.duration_ms;
      if (t.album?.release_date && !currentTrackInfo.releaseDate)
        currentTrackInfo.releaseDate = t.album.release_date;
    }

    // Spotify にプレビュー URL があれば Apple Music プレビューを置き換え
    if (t.preview_url) {
      const content = document.getElementById('itunesPreviewContent');
      // Apple Music プレビューがない場合のみ Spotify プレビューを表示
      if (content && content.innerHTML.trim() === '') {
        content.innerHTML = `
          <div class="itunes-preview-wrap">
            <div class="itunes-preview-header">
              <span class="itunes-preview-label">🎵 Spotify プレビュー (30秒)</span>
              ${t.external_urls?.spotify ? `<a href="${escapeHtml(t.external_urls.spotify)}" target="_blank" class="itunes-open-link">Spotify で開く</a>` : ''}
            </div>
            <audio controls class="itunes-preview-audio">
              <source src="${escapeHtml(t.preview_url)}" type="audio/mpeg">
              プレビューに対応していないブラウザです
            </audio>
          </div>`;
        showPreviewSection();
      }
    }

    _cacheSet("spotify", title, artist, t);
    return t;
  } catch (err) {
    debugLog("Spotify: エラー", { message: err.message }, { status: "error", duration_ms: Date.now() - t0 });
    return null;
  }
}

function showItunesPreview(itunesData) {
  const content = document.getElementById('itunesPreviewContent');
  if (!content) return;

  if (!itunesData?.previewUrl) {
    content.innerHTML = '';
    showPreviewSection();
    return;
  }

  content.innerHTML = `
    <div class="itunes-preview-wrap">
      <div class="itunes-preview-header">
        <span class="itunes-preview-label">🍎 Apple Music プレビュー</span>
        ${itunesData.trackViewUrl ? `<a href="${escapeHtml(itunesData.trackViewUrl)}" target="_blank" class="itunes-open-link">Apple Music で開く</a>` : ''}
      </div>
      <audio controls class="itunes-preview-audio">
        <source src="${escapeHtml(itunesData.previewUrl)}" type="audio/mpeg">
        プレビューに対応していないブラウザです
      </audio>
    </div>`;

  debugLog('Apple Music: プレビュー表示', { previewUrl: itunesData.previewUrl });
  showPreviewSection();
}

/* ========= YouTube 関連 ========= */

// YouTube URLからvideo IDを抽出
function extractYouTubeVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    // youtu.be/XXXXX 形式
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    // youtube.com/watch?v=XXXXX 形式
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
  } catch {
    return null;
  }
  return null;
}

// MusicBrainzのURLかAPIどちらかからvideo IDを取得して埋め込みを表示
async function fetchAndShowYouTube(title, artist, mbYoutubeUrl) {
  const section = document.getElementById("youtubeSection");
  const content = document.getElementById("youtubeContent");
  if (!section || !content) return;

  // キャッシュ確認（MusicBrainz URL込みでキーを作る）
  const ytCacheKey = mbYoutubeUrl || "";
  const cachedYt = _cacheGet("yt", title, artist + ytCacheKey);
  if (cachedYt) {
    debugLog("YouTube: キャッシュ使用", { title, artist });
    section.style.display = "block";
    renderYouTubeEmbed(content, cachedYt, false);
    return;
  }

  section.style.display = "block";
  content.innerHTML = `<div class="yt-loading"><span class="loading-spinner"></span> YouTube動画を検索中...</div>`;

  debugLog("YouTube: 検索開始", { title, artist, has_mb_youtube_url: !!mbYoutubeUrl });

  // ① MusicBrainzが持っているURLをまず使う（APIコスト0）
  const mbVideoId = extractYouTubeVideoId(mbYoutubeUrl);
  if (mbVideoId) {
    const videos = [{
      videoId: mbVideoId,
      title: `${title} - ${artist}`,
      channel: "MusicBrainz登録リンク",
      thumbnail: `https://img.youtube.com/vi/${mbVideoId}/mqdefault.jpg`
    }];
    debugLog("YouTube: MusicBrainzにYouTube URLあり", { mb_youtube_url: mbYoutubeUrl, video_id: mbVideoId });
    _cacheSet("yt", title, artist + ytCacheKey, videos);
    renderYouTubeEmbed(content, videos, true);
    return;
  }

  // ② フォールバック: YouTube Data API で検索
  try {
    debugLog("YouTube: Workerへ送信", { title, artist, endpoint: `${WORKER_URL}youtube` });
    const ytT0 = Date.now();
    const res = await fetch(`${WORKER_URL}youtube`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist })
    });
    const ytDuration = Date.now() - ytT0;
    const json = await res.json();

    debugLog("YouTube: Workerレスポンス受信", {
      http_status: res.status,
      success: json.success,
      duration_ms: ytDuration,
      video_count: json.videos?.length ?? 0,
      videos: json.videos ?? [],
      error: json.error ?? null,
      detail: json.detail ?? null
    }, { duration_ms: ytDuration, status: json.success ? "ok" : "error" });
    debugLogWorker("YouTube", json, res.status);

    if (!json.success || !json.videos || json.videos.length === 0) {
      const reason = json.error || "不明なエラー";
      const detail = json.detail ? JSON.stringify(json.detail) : "";
      content.innerHTML = `<div class="yt-loading">YouTube動画が見つかりませんでした 😢<br><small style="color:var(--txt-muted);">error: ${escapeHtml(reason)} ${escapeHtml(detail)}</small></div>`;
      return;
    }

    _cacheSet("yt", title, artist + ytCacheKey, json.videos);
    renderYouTubeEmbed(content, json.videos, false);
  } catch (err) {
    debugLog("YouTube: 例外発生", { message: err.message }, { status: "error" });
    content.innerHTML = `<div class="yt-loading">YouTube検索に失敗しました 😢<br><small style="color:var(--txt-muted);">${escapeHtml(err.message)}</small></div>`;
  }
}

// YouTube IFrame Player API をロード（1回だけ）
let ytApiLoaded = false;
function loadYouTubeAPI() {
  if (ytApiLoaded || document.getElementById("yt-api-script")) return;
  ytApiLoaded = true;
  const tag = document.createElement("script");
  tag.id = "yt-api-script";
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
}

// YT.Playerインスタンスを保持
let currentYTPlayer = null;

let _ytPendingPlay = null;

// グローバルコールバック（YouTube API が呼ぶ — 初回ロード時のみ発火）
window.onYouTubeIframeAPIReady = function() {
  if (_ytPendingPlay) {
    const { videoId, videos, index } = _ytPendingPlay;
    _ytPendingPlay = null;
    playYTVideo(videoId, videos, index);
  }
};

// IFrame Player APIでプレーヤーを生成・エラー時に自動スキップ
function playYTVideo(videoId, videos, currentIndex) {
  const playerArea = document.getElementById("ytPlayerArea");
  if (!playerArea) return;

  // 既存プレーヤーを破棄
  if (currentYTPlayer) {
    try { currentYTPlayer.destroy(); } catch(e) {}
    currentYTPlayer = null;
  }

  // プレーヤー用divをリセット（外側ラッパー + YTが置き換える内側div）
  playerArea.innerHTML = '<div id="ytPlayerOuter"><div id="ytPlayerDiv"></div></div>';

  if (typeof YT === "undefined" || typeof YT.Player === "undefined") {
    // APIロード前: _ytPendingPlay に積む（onYouTubeIframeAPIReady が受け取る）
    // APIロード済みだが YT.Player が一時的に未定義の場合はリトライ
    if (!ytApiLoaded) {
      _ytPendingPlay = { videoId, videos, index: currentIndex };
    } else {
      setTimeout(() => playYTVideo(videoId, videos, currentIndex), 300);
    }
    return;
  }

  currentYTPlayer = new YT.Player("ytPlayerDiv", {
    videoId: videoId,
    width:  "100%",
    height: "100%",
    playerVars: {
      rel:            0,
      modestbranding: 1,
      autoplay:       1,
      mute:           1,
      playsinline:    1
    },
    events: {
      onReady: function(e) {
        // ミュート自動再生後、ユーザーが操作したらミュート解除
        e.target.playVideo();
      },
      onError: function(e) {
        console.warn("YT Player error:", e.data, "→ 次の候補へ");
        debugLog("YouTube: 埋め込みエラー → 次の候補へ", { error_code: e.data, video_id: videoId, tried_index: currentIndex, error_meaning: e.data === 101 || e.data === 150 || e.data === 153 ? "埋め込み禁止" : e.data === 2 ? "無効なvideoid" : e.data === 5 ? "HTML5プレーヤーエラー" : "不明" }, { status: "ok" });
        tryNextVideo(videos, currentIndex);
      }
    }
  });
}

// 次の埋め込み可能な動画を試す
function tryNextVideo(videos, failedIndex) {
  const nextIndex = failedIndex + 1;
  if (nextIndex >= videos.length) {
    // 全候補が埋め込み不可
    const playerArea = document.getElementById("ytPlayerArea");
    if (playerArea) {
      playerArea.innerHTML = `
        <div class="yt-loading" style="flex-direction:column; gap:8px;">
          <span>埋め込みができる動画が見つかりませんでした 😢</span>
          <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(
            (currentTrackInfo?.title || "") + " " + (currentTrackInfo?.artist || "")
          )}" target="_blank" class="mb-link" style="font-size:13px;">YouTubeで検索する</a>
        </div>`;
    }
    return;
  }

  // 次の候補のリストアイテムをアクティブに
  const list = document.querySelector(".yt-video-list");
  if (list) {
    const items = list.querySelectorAll(".yt-video-item");
    items.forEach((el, i) => el.classList.toggle("yt-video-item--active", i === nextIndex));
  }

  playYTVideo(videos[nextIndex].videoId, videos, nextIndex);
}

// 動画リスト + 埋め込みプレーヤーを描画
function renderYouTubeEmbed(container, videos, autoEmbed) {
  loadYouTubeAPI();

  let html = `<div id="ytPlayerArea"><div id="ytPlayerOuter"><div id="ytPlayerDiv"></div></div></div>`;

  // 候補リスト
  html += `<div class="yt-video-list">`;
  videos.forEach((v, i) => {
    html += `
      <div class="yt-video-item ${i === 0 ? 'yt-video-item--active' : ''}"
           data-video-id="${escapeHtml(v.videoId)}"
           data-index="${i}"
           onclick="embedYouTubeVideo('${escapeHtml(v.videoId)}', ${i}, this)">
        <img class="yt-thumbnail" src="${escapeHtml(v.thumbnail)}" alt="thumbnail" loading="lazy"
             onerror="this.src='https://img.youtube.com/vi/${escapeHtml(v.videoId)}/mqdefault.jpg'">
        <div class="yt-video-info">
          <div class="yt-video-title">${escapeHtml(v.title)}</div>
          <div class="yt-video-channel">📺 ${escapeHtml(v.channel)}</div>
        </div>
        <span class="yt-play-icon">▶</span>
      </div>
    `;
  });
  html += `</div>`;

  container.innerHTML = html;

  // 動画リストをグローバルに保持（tryNextVideoで使う）
  window._ytVideoList = videos;

  // 最初の動画を自動再生（DOM確定を待つため500ms）
  setTimeout(() => playYTVideo(videos[0].videoId, videos, 0), 500);
}

// 候補リストからクリックされた動画を埋め込み
function embedYouTubeVideo(videoId, index, clickedEl) {
  // アクティブ状態を更新
  const list = clickedEl.closest(".yt-video-list");
  if (list) {
    list.querySelectorAll(".yt-video-item").forEach(el => el.classList.remove("yt-video-item--active"));
  }
  clickedEl.classList.add("yt-video-item--active");

  const videos = window._ytVideoList || [];
  playYTVideo(videoId, videos, index);
}

/* ========= MusicBrainz 取得 ========= */
async function fetchMusicBrainz(title, artist) {
  if (!mbDetail) return;

  const cached = _cacheGet("mb", title, artist);
  if (cached) {
    debugLog("MusicBrainz: キャッシュ使用", { title, artist });
    displayMusicBrainzInfo(cached);
    return;
  }

  mbDetail.textContent = "MusicBrainz 取得中…";

  debugLog("MusicBrainz: Workerへ送信", { title, artist, endpoint: `${WORKER_URL}musicbrainz` });
  const mbT0 = Date.now();   // ← tryの外で宣言

  try {
    const res = await fetch(`${WORKER_URL}musicbrainz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist })
    });

    const mbDuration = Date.now() - mbT0;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    debugLog("MusicBrainz: Workerレスポンス受信", {
      http_status: res.status,
      success: json.success,
      duration_ms: mbDuration,
      recording: json.recording ?? null,
      error: json.error ?? null
    }, { duration_ms: mbDuration, status: json.success ? "ok" : "warn" });
    debugLogWorker("MusicBrainz", json, res.status);

    if (!json.success) {
      mbDetail.textContent = "MusicBrainz 情報なし";
      return;
    }

    _cacheSet("mb", title, artist, json.recording);
    displayMusicBrainzInfo(json.recording);

  } catch (error) {
    debugLog("MusicBrainz: エラー", { message: error.message }, { status: "error" });
    mbDetail.textContent = "MusicBrainz 取得失敗";
  }
}

function displayMusicBrainzInfo(r) {
  
  try {
    let html = `<div class="card mb-detail">`;
  
    // 基本情報
    html += `
      <div class="mb-section">
        <h4 data-source="出典: MusicBrainz API">📀 基本情報</h4>
        <div class="mb-row"><span class="label">Recording ID:</span> <code class="code-inline">${escapeHtml(r.id)}</code></div>
        <div class="mb-row"><span class="label">タイトル:</span> ${escapeHtml(r.title)}</div>
        <div class="mb-row"><span class="label">アーティスト:</span> ${escapeHtml(r.artist)}</div>
        ${r.duration ? `<div class="mb-row"><span class="label">長さ:</span> ${formatDuration(r.duration)}</div>` : ''}
        ${r.score !== undefined && r.score !== null ? `<div class="mb-row"><span class="label">検索スコア:</span> ${r.score}</div>` : ''}
        ${r.disambiguation ? `<div class="mb-row"><span class="label">備考:</span> ${escapeHtml(r.disambiguation)}</div>` : ''}
        ${r.isrcs && r.isrcs.length > 0 ? `<div class="mb-row"><span class="label">ISRC:</span> <span class="mb-isrc-list">${r.isrcs.map(code => `<a class="isrc-badge isrc-badge--mb" href="https://musicbrainz.org/search?query=${encodeURIComponent(code)}&type=recording" target="_blank">${escapeHtml(code)}</a>`).join('')}</span></div>` : ''}
        ${r.rating != null ? `<div class="mb-row"><span class="label">評価:</span> <span class="mb-rating">${'★'.repeat(Math.round(r.rating / 20))}${'☆'.repeat(5 - Math.round(r.rating / 20))}</span> <span class="mb-rating-value">${r.rating.toFixed(1)} / 100${r.rating_count ? ` (${r.rating_count}票)` : ''}</span></div>` : ''}
        ${r.annotation ? `<div class="mb-row"><span class="label">アノテーション:</span> <span class="mb-annotation">${escapeHtml(r.annotation)}</span></div>` : ''}
      </div>
    `;

    // リリース情報
    if (r.release_title || r.release_date || r.release_country || r.release_type || r.release_status || r.release_barcode) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">💿 リリース情報（最初のリリース）</h4>
          ${r.release_title ? `<div class="mb-row"><span class="label">アルバム:</span> ${escapeHtml(r.release_title)}</div>` : ''}
          ${r.release_date ? `<div class="mb-row"><span class="label">リリース日:</span> ${formatDate(r.release_date)}</div>` : ''}
          ${r.release_country ? `<div class="mb-row"><span class="label">リリース国:</span> ${escapeHtml(r.release_country)}</div>` : ''}
          ${r.release_type ? `<div class="mb-row"><span class="label">タイプ:</span> ${escapeHtml(r.release_type)}</div>` : ''}
          ${r.release_status ? `<div class="mb-row"><span class="label">ステータス:</span> ${escapeHtml(r.release_status)}</div>` : ''}
          ${r.release_barcode ? `<div class="mb-row"><span class="label">バーコード:</span> ${escapeHtml(r.release_barcode)}</div>` : ''}
        </div>
      `;
    }

    // 全リリース情報（複数ある場合）
    if (r.releases && r.releases.length > 1) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">💿 全てのリリース (${r.releases.length}件)</h4>
      `;
      
      r.releases.forEach((release, index) => {
        html += `
          <div class="mb-release">
            <div class="mb-release-header">リリース ${index + 1}</div>
            ${release.title ? `<div class="mb-row"><span class="label">アルバム:</span> ${escapeHtml(release.title)}</div>` : ''}
            ${release.date ? `<div class="mb-row"><span class="label">リリース日:</span> ${formatDate(release.date)}</div>` : ''}
            ${release.country ? `<div class="mb-row"><span class="label">国:</span> ${escapeHtml(release.country)}</div>` : ''}
            ${release.type ? `<div class="mb-row"><span class="label">タイプ:</span> ${escapeHtml(release.type)}</div>` : ''}
            ${release.status ? `<div class="mb-row"><span class="label">ステータス:</span> ${escapeHtml(release.status)}</div>` : ''}
            ${release.media_format ? `<div class="mb-row"><span class="label">フォーマット:</span> ${escapeHtml(release.media_format)}</div>` : ''}
            ${release.label_name ? `<div class="mb-row"><span class="label">レーベル:</span> ${escapeHtml(release.label_name)}</div>` : ''}
            ${release.catalog_number ? `<div class="mb-row"><span class="label">カタログ番号:</span> ${escapeHtml(release.catalog_number)}</div>` : ''}
            ${release.track_number ? `<div class="mb-row"><span class="label">トラック:</span> ${release.track_number}${release.track_count ? ` / ${release.track_count}` : ''}</div>` : ''}
            ${release.barcode ? `<div class="mb-row"><span class="label">バーコード:</span> ${escapeHtml(release.barcode)}</div>` : ''}
          </div>
        `;
      });
      
      html += `</div>`;
    }

    // トラック情報
    if (r.track_number || r.track_count || r.disc_number || r.media_format) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🎵 トラック情報</h4>
          ${r.track_number ? `<div class="mb-row"><span class="label">トラック番号:</span> ${r.track_number}${r.track_count ? ` / ${r.track_count}` : ''}</div>` : ''}
          ${r.disc_number ? `<div class="mb-row"><span class="label">ディスク番号:</span> ${r.disc_number}</div>` : ''}
          ${r.media_format ? `<div class="mb-row"><span class="label">メディア:</span> ${escapeHtml(r.media_format)}</div>` : ''}
        </div>
      `;
    }

    // レーベル情報
    if (r.label_name || r.catalog_number) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🏷️ レーベル情報</h4>
          ${r.label_name ? `<div class="mb-row"><span class="label">レーベル:</span> ${escapeHtml(r.label_name)}</div>` : ''}
          ${r.catalog_number ? `<div class="mb-row"><span class="label">カタログ番号:</span> ${escapeHtml(r.catalog_number)}</div>` : ''}
        </div>
      `;
    }

    // アーティスト詳細（複数アーティスト・結合タイプ）
    if (r.artist_details && r.artist_details.length > 1) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🎤 アーティスト詳細</h4>
          ${r.artist_details.map(a => `
            <div class="mb-artist-row">
              <span class="mb-artist-name">${escapeHtml(a.name)}</span>
              ${a.join_phrase ? `<span class="mb-artist-join">${escapeHtml(a.join_phrase)}</span>` : ''}
              ${a.sort_name && a.sort_name !== a.name ? `<span class="mb-artist-sort">(${escapeHtml(a.sort_name)})</span>` : ''}
            </div>`).join('')}
        </div>
      `;
    }

    // 楽曲情報（Works: 作曲者・作詞者）
    if (r.works && r.works.length > 0) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🎼 楽曲情報（Works）</h4>
          ${r.works.map(w => `
            <div class="mb-work-row">
              ${w.title ? `<div class="mb-row"><span class="label">タイトル:</span> ${escapeHtml(w.title)}</div>` : ''}
              ${w.type  ? `<div class="mb-row"><span class="label">タイプ:</span> ${escapeHtml(w.type)}</div>` : ''}
              ${w.composers && w.composers.length > 0 ? `<div class="mb-row"><span class="label">作曲:</span> ${w.composers.map(c => escapeHtml(c)).join('、')}</div>` : ''}
              ${w.lyricists && w.lyricists.length > 0 ? `<div class="mb-row"><span class="label">作詞:</span> ${w.lyricists.map(l => escapeHtml(l)).join('、')}</div>` : ''}
            </div>`).join('')}
        </div>
      `;
    }

    // 外部URL（Wikidata・公式サイト等、YouTubeは除外）
    const displayUrls = (r.urls || []).filter(u => u.url && !u.url.includes('youtube.com') && !u.url.includes('youtu.be'));
    if (displayUrls.length > 0) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🌐 外部リンク</h4>
          <div class="mb-url-list">
            ${displayUrls.map(u => `
              <div class="mb-url-row">
                <a href="${escapeHtml(u.url)}" target="_blank" class="mb-ext-link">${escapeHtml(u.label || u.url)}</a>
              </div>`).join('')}
          </div>
        </div>
      `;
    }

    // ジャンル
    if (r.genres && r.genres.length > 0) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🎼 ジャンル</h4>
          <div class="mb-tags">
            ${r.genres.map(g => `<span class="tag genre-tag">${escapeHtml(g.name)} <span class="tag-count">${g.count}</span></span>`).join('')}
          </div>
        </div>
      `;
    }

    // タグ
    if (r.tags && r.tags.length > 0) {
      html += `
        <div class="mb-section">
          <h4 data-source="出典: MusicBrainz API">🏷️ タグ</h4>
          <div class="mb-tags">
            ${r.tags.map(t => `<span class="tag">${escapeHtml(t.name)} <span class="tag-count">${t.count}</span></span>`).join('')}
          </div>
        </div>
      `;
    }

    // MusicBrainzリンク
    html += `
      <div class="mb-section">
        <h4>🔗 MusicBrainz</h4>
        <a target="_blank" href="https://musicbrainz.org/recording/${escapeHtml(r.id)}" class="mb-link">
          MusicBrainz で詳細を見る
        </a>
      </div>
    `;

    html += `</div>`;
    mbDetail.innerHTML = html;
      
    // Apple Music情報を追加で取得して表示（リンクのみ、プレビューは previewSection で表示）
    if (currentTrackInfo?.itunesData) {
      const itunesData = currentTrackInfo.itunesData;
      const itunesHtml = `
        <div class="itunes-info">
          <h4>🍎 Apple Music</h4>
          <div style="margin-top:10px;">
            <a target="_blank" href="${escapeHtml(itunesData.trackViewUrl)}" class="mb-link" style="font-size:13px;">
              Apple Music で開く
            </a>
          </div>
        </div>
      `;
      
      const mbDetailCard = mbDetail.querySelector('.mb-detail');
      if (mbDetailCard) {
        const lastSection = mbDetailCard.querySelector('.mb-section:last-child');
        if (lastSection) {
          lastSection.insertAdjacentHTML('afterend', itunesHtml);
        }
      }
    }

    // YouTube埋め込みを取得・表示
    fetchAndShowYouTube(r.title, r.artist, r.youtube_url).catch(err => {
      console.error("YouTube fetch failed:", err);
    });

    // ⑥ Wikipedia概要を取得・表示
    fetchWikipedia(r.artist, r.wikidata_id).catch(err => {
      console.error("Wikipedia fetch failed:", err);
    });
    
  } catch (error) {
    console.error('Error in displayMusicBrainzInfo:', error);
    mbDetail.innerHTML = `<div class="card"><p style="color: #ef4444;">MusicBrainz情報の表示中にエラーが発生しました</p></div>`;
  }
}

/* ========= アルバムアート機能 ========= */
function toggleArtSize(img) {
  if (img.style.maxWidth === '100%') {
    img.style.maxWidth = '300px';
  } else {
    img.style.maxWidth = '100%';
  }
}

async function downloadArt(url, filename) {
  try {
    showToast('ダウンロード中...', 'info');
    // fetch で取得して Blob URL 経由でダウンロード（クロスオリジン対応）
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href     = blobUrl;
    a.download = `${filename}_cover.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    showToast('ダウンロードを開始しました', 'success');
  } catch (err) {
    console.error('Download failed:', err);
    // フォールバック: 新しいタブで開く
    window.open(url, '_blank');
    showToast('新しいタブで開きました（手動で保存してください）', 'info');
  }
}

function copyArtUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('URLをコピーしました', 'success');
  }).catch(err => {
    console.error('Copy failed:', err);
    showToast('コピー失敗', 'error');
  });
}

function openArtNewTab(url) {
  window.open(url, '_blank');
}

// 要素IDベースのヘルパー関数
function downloadArtByElement(elementId, filename) {
  const img = document.getElementById(elementId);
  if (img) {
    const url = img.dataset.originalUrl || img.src;
    downloadArt(url, filename);
  }
}

function copyArtUrlByElement(elementId) {
  const img = document.getElementById(elementId);
  if (img) {
    const url = img.dataset.originalUrl || img.src;
    copyArtUrl(url);
  }
}

function openArtNewTabByElement(elementId) {
  const img = document.getElementById(elementId);
  if (img) {
    const url = img.dataset.originalUrl || img.src;
    openArtNewTab(url);
  }
}

/* ========= トースト通知 ========= */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `
    <span style="font-size:20px;">${icon}</span>
    <span style="font-weight:600;">${escapeHtml(message)}</span>
  `;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => {
      document.body.removeChild(toast);
    }, 300);
  }, 3000);
}

/* ========= 曲情報比較機能 ========= */
let comparisonList = [];

function addToComparison(trackInfo) {
  if (comparisonList.length >= 5) {
    showToast('比較リストは最大5曲までです', 'error');
    return;
  }
  
  comparisonList.push(trackInfo);
  showToast(`比較リストに追加: ${trackInfo.title}`, 'success');
  updateComparisonView();
}

function removeFromComparison(index) {
  comparisonList.splice(index, 1);
  updateComparisonView();
  showToast('比較リストから削除しました', 'info');
}

function clearComparison() {
  comparisonList = [];
  updateComparisonView();
  showToast('比較リストをクリアしました', 'info');
}

function updateComparisonView() {
  const wrap  = document.getElementById("comparisonTableWrap");
  const count = document.getElementById("comparisonCount");
  const fab   = document.getElementById("compareFab");
  const fabCount = document.getElementById("compareFabCount");
  if (count) count.textContent = comparisonList.length;
  if (fab)   fab.style.display = comparisonList.length > 0 ? "" : "none";
  if (fabCount) fabCount.textContent = comparisonList.length;

  if (!wrap) return;
  if (comparisonList.length === 0) {
    wrap.innerHTML = "<div class='cloud-sync-hint'>比較リストは空です。認識結果の「➕ 比較リストに追加」ボタンで追加してください。</div>";
    return;
  }

  // フィールド定義
  const fields = [
    { key: "title",       label: "曲名" },
    { key: "artist",      label: "アーティスト" },
    { key: "album",       label: "アルバム" },
    { key: "genre",       label: "ジャンル" },
    { key: "releaseDate", label: "リリース日" },
    { key: "isrc",        label: "ISRC" },
    { key: "durationMs",  label: "再生時間",
      fmt: v => v ? `${Math.floor(v/60000)}:${String(Math.floor((v%60000)/1000)).padStart(2,"0")}` : "—" },
    { key: "spotifyUrl",  label: "Spotify",
      fmt: v => v ? `<a href="${escapeHtml(v)}" target="_blank" class="compare-link">開く</a>` : "—" },
  ];

  let html = `<table class="comparison-table">
    <thead><tr><th>項目</th>${comparisonList.map((_, i) => `<th>曲 ${i+1} <button class="compare-remove-btn" onclick="removeFromComparison(${i})">✕</button></th>`).join("")}</tr></thead>
    <tbody>`;

  for (const f of fields) {
    html += `<tr><td class="compare-field-label">${f.label}</td>`;
    const vals = comparisonList.map(t => {
      const raw = t?.[f.key];
      if (f.fmt) return f.fmt(raw);
      return raw ? escapeHtml(String(raw)) : "<span class='compare-empty'>—</span>";
    });
    // 値が全部同じなら通常、違えば強調
    const allSame = vals.every(v => v === vals[0]);
    html += vals.map(v => `<td class="${allSame ? "" : "compare-diff"}">${v}</td>`).join("");
    html += "</tr>";
  }

  html += "</tbody></table>";
  wrap.innerHTML = html;
}

/** 比較モーダルを開く。 */
function openComparisonModal() {
  updateComparisonView();
  const modal = document.getElementById("comparisonModal");
  if (modal) modal.classList.add("is-open");
}

/** 比較モーダルを閉じる。 */
function closeComparisonModal() {
  const modal = document.getElementById("comparisonModal");
  if (modal) modal.classList.remove("is-open");
}

/* ========= Spotify プレイリスト表示 ========= */

/**
 * 「Trackora」プレイリストを取得して表示する。
 * トークンがなければ OAuth フローを起動する。
 */
async function loadSpotifyPlaylist() {
  const section  = document.getElementById("spotifyPlaylistSection");
  const content  = document.getElementById("spotifyPlaylistContent");
  if (!section || !content) return;

  section.style.display = "block";

  let token = getSpotifyToken();
  if (!token) {
    await startSpotifyAuth();
    token = getSpotifyToken();
    if (!token) return;
  }

  content.innerHTML = `<div class="spotify-pl-loading"><span class="loading-spinner"></span> プレイリストを読み込み中...</div>`;

  try {
    const res  = await fetch(`${WORKER_URL}spotify/playlist`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ access_token: token })
    });
    const json = await res.json();

    if (!json.success) throw new Error(json.error);

    if (!json.tracks || json.tracks.length === 0) {
      content.innerHTML = `
        <div class="spotify-pl-empty">
          <p>「Trackora」プレイリストにまだ曲がありません。</p>
          <p>認識結果の「🎵 プレイリストに追加」ボタンで追加できます。</p>
        </div>`;
      return;
    }

    const headerHtml = `
      <div class="spotify-pl-header">
        <span class="spotify-pl-count">${json.total} 曲</span>
        ${json.playlist_url ? `<a href="${escapeHtml(json.playlist_url)}" target="_blank" class="spotify-open-link">Spotify で開く ↗</a>` : ''}
      </div>`;

    const tracksHtml = json.tracks.map((t, i) => {
      const duration = t.duration_ms
        ? `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0")}`
        : "";
      return `
        <div class="spotify-pl-item" onclick="embedSpotifyTrack('${escapeHtml(t.id)}')">
          ${t.artwork
            ? `<img class="spotify-pl-art" src="${escapeHtml(t.artwork)}" alt="art" loading="lazy">`
            : `<div class="spotify-pl-art spotify-pl-art--empty">🎵</div>`}
          <div class="spotify-pl-info">
            <div class="spotify-pl-title">${escapeHtml(t.name)}</div>
            <div class="spotify-pl-artist">${escapeHtml(t.artist)}</div>
          </div>
          <span class="spotify-pl-duration">${duration}</span>
          <span class="spotify-pl-play">▶</span>
        </div>`;
    }).join("");

    content.innerHTML = headerHtml + `<div class="spotify-pl-list">${tracksHtml}</div>`;

  } catch (err) {
    content.innerHTML = `<div class="spotify-pl-empty">読み込みに失敗しました: ${escapeHtml(err.message)}</div>`;
  }
}

/** プレイリストから曲を選んで Spotify embed に表示する。 */
function embedSpotifyTrack(trackId) {
  if (!trackId) return;
  const prevSection = document.getElementById("previewSection");
  if (prevSection) prevSection.style.display = "block";
  showSpotifyEmbed(trackId);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ========= Spotify プレイリスト連携 ========= */
/**
 * localStorage に保存された Spotify アクセストークンを返す。
 * 期限切れ（expires_at を過ぎている）なら null を返す。
 */
function getSpotifyToken() {
  const token     = localStorage.getItem("spotify_access_token");
  const expiresAt = parseInt(localStorage.getItem("spotify_token_expires_at") || "0", 10);
  if (!token || Date.now() > expiresAt) return null;
  return token;
}

/**
 * Spotify OAuth フローを開始する。
 * Worker /spotify/auth から認可 URL を取得してポップアップウィンドウで開く。
 * 認可後、ポップアップが localStorage に access_token を書き込んで閉じる。
 */
async function startSpotifyAuth() {
  const redirectUri = `${location.origin}${location.pathname}spotify-callback.html`;
  try {
    const res  = await fetch(`${WORKER_URL}spotify/auth?redirect_uri=${encodeURIComponent(redirectUri)}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    localStorage.setItem("spotify_auth_state", json.state);
    const popup = window.open(json.auth_url, "spotify_auth", "width=480,height=640");
    // ポップアップが閉じたら状態チェック
    const timer = setInterval(() => {
      if (popup?.closed) {
        clearInterval(timer);
        const token = getSpotifyToken();
        if (token) showToast("Spotify 連携完了 ✓", "success");
        else        showToast("Spotify 連携がキャンセルされました", "info");
      }
    }, 500);
  } catch (err) {
    showToast(`Spotify 認証エラー: ${err.message}`, "error");
  }
}

/**
 * 現在認識中の楽曲を Spotify プレイリスト「Trackora」に追加する。
 * 未ログインの場合は OAuth フローを開始する。
 * @param {string} title
 * @param {string} artist
 * @param {string|null} trackUri  Spotify track URI（任意）
 */
async function addToSpotifyPlaylist(title, artist, trackUri = null) {
  const token = getSpotifyToken();
  if (!token) {
    showToast("Spotify にログインしてプレイリスト追加します...", "info");
    await startSpotifyAuth();
    return;
  }
  const btn = document.getElementById("spotifyPlaylistBtn");
  if (btn) { btn.disabled = true; btn.textContent = "追加中…"; }
  try {
    const res  = await fetch(`${WORKER_URL}spotify/playlist/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token, title, artist, track_uri: trackUri }),
    });
    const json = await res.json();
    if (json.success) {
      showToast("✅ Spotify プレイリストに追加しました", "success");
      if (btn) btn.textContent = "✅ 追加済み";
    } else {
      throw new Error(json.error);
    }
  } catch (err) {
    showToast(`追加失敗: ${err.message}`, "error");
    if (btn) { btn.disabled = false; btn.textContent = "🎵 プレイリストに追加"; }
  }
}

/* ========= 共有機能 ========= */
function shareTrack(title, artist, url) {
  if (navigator.share) {
    navigator.share({
      title: `${title} - ${artist}`,
      text: `今聴いている曲: ${title} by ${artist}`,
      url: url || window.location.href
    }).then(() => {
      showToast('共有しました', 'success');
    }).catch(err => {
      console.error('Share failed:', err);
    });
  } else {
    const text = `${title} - ${artist}`;
    navigator.clipboard.writeText(text).then(() => {
      showToast('曲情報をコピーしました', 'success');
    });
  }
}

/* ========= 初期化 ========= */
document.addEventListener('DOMContentLoaded', function() {

  
  try {
    // DOM要素を取得
    fileInput = document.getElementById("fileInput");
    fileSend = document.getElementById("fileSend");
    dropZone = document.getElementById("dropZone");
    resultArea = document.getElementById("result");
    mbDetail = document.getElementById("mbDetail");
    historyArea = document.getElementById("history");
    debug = document.getElementById("debug");
    debugToggle = document.getElementById("debugToggle");
    
    recBtn = document.getElementById("recBtn");
    stopBtn = document.getElementById("stopBtn");
    recSec = document.getElementById("recSec");
    counter = document.getElementById("counter");
    micSelect = document.getElementById("micSelect");
    recordPreview = document.getElementById("recordPreview");
    sendRecordBtn = document.getElementById("sendRecordBtn");
    
    
    historySearch = document.getElementById("historySearch");
    clearHistoryBtn = document.getElementById("clearHistory");
    exportHistoryBtn = document.getElementById("exportHistory");
    

    
    if (!fileInput || !fileSend || !dropZone || !resultArea) {
      throw new Error('Required DOM elements not found');
    }
    
    // イベントリスナー設定
    
    fileSend.addEventListener('click', () => {
      send(fileInput.files[0]);
    });

    // ファイル選択時: 選択ファイル名を表示
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      const info = document.getElementById('selectedFileInfo');
      if (f && info) {
        info.style.display = 'flex';
        info.innerHTML = `
          <span class="selected-file-icon">🎵</span>
          <span class="selected-file-name">${escapeHtml(f.name)}</span>
          <span class="selected-file-size">${(f.size / 1024 / 1024).toFixed(2)} MB</span>`;
      }
    });

    // ドラッグ＆ドロップ (label全体が対象)
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add("drag");
    });
    dropZone.addEventListener('dragleave', (e) => {
      // 子要素へのmouseoutは無視
      if (dropZone.contains(e.relatedTarget)) return;
      dropZone.classList.remove("drag");
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag");
      const f = e.dataTransfer.files[0];
      if (!f) return;
      // DataTransferのファイルをinputに反映（できる範囲で）
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        fileInput.files = dt.files;
      } catch(_) {}
      // ファイル名表示
      const info = document.getElementById('selectedFileInfo');
      if (info) {
        info.style.display = 'flex';
        info.innerHTML = `
          <span class="selected-file-icon">🎵</span>
          <span class="selected-file-name">${escapeHtml(f.name)}</span>
          <span class="selected-file-size">${(f.size / 1024 / 1024).toFixed(2)} MB</span>`;
      }
      send(f);
    });
    
    // 履歴機能のイベントリスナー
    if (historySearch) {
      historySearch.addEventListener('input', (e) => {
        loadHistory(e.target.value);
      });
    }
    
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', clearAllHistory);
    }
    
    if (exportHistoryBtn) {
      exportHistoryBtn.addEventListener('click', openExportModal);
    }
    
    // 録音機能のセットアップ
    setupRecordingHandlers();
    
    // マイクを列挙
    enumerateMicrophones();
    
    // テーマを初期化
    initTheme();
    
    // デバッグパネル初期化
    initDebugPanel();

    // グローバル関数を公開
    window.toggleArtSize = toggleArtSize;
    window.downloadArt = downloadArt;
    window.copyArtUrl = copyArtUrl;
    window.openArtNewTab = openArtNewTab;
    window.downloadArtByElement = downloadArtByElement;
    window.copyArtUrlByElement = copyArtUrlByElement;
    window.openArtNewTabByElement = openArtNewTabByElement;
    window.shareTrack = shareTrack;
    window.toggleTheme = toggleTheme;
    window.embedYouTubeVideo = embedYouTubeVideo;
    window.openShortcutPanel = openShortcutPanel;
    window.closeShortcutPanel = closeShortcutPanel;
    window.showSpotifyEmbed = showSpotifyEmbed;
    window.fetchSpotifyTrackInfo = fetchSpotifyTrackInfo;
    window.openShareCardModal = openShareCardModal;
    window.closeShareCardModal = closeShareCardModal;
    window.setShareFormat = setShareFormat;
    
    // キーボードショートカット初期化
    initKeyboardShortcuts();

    // 統計パネル初期化
    initStatsPanel();

    // クラウド自動同期（バックグラウンド時はスキップ）
    const _doSync = () => { if (!document.hidden) autoSyncFromCloud(); };
    setTimeout(_doSync, 2000);
    // 5分おきの定期自動同期
    setInterval(_doSync, 5 * 60 * 1000);
    // タブがアクティブに戻ったときだけ同期
    document.addEventListener("visibilitychange", () => { if (!document.hidden) autoSyncFromCloud(); });
    // 最終同期日時を復元
    // Spotify ログイン済みならプレイリストセクションを表示
    if (getSpotifyToken()) {
      const plSection = document.getElementById("spotifyPlaylistSection");
      if (plSection) plSection.style.display = "block";
      loadSpotifyPlaylist();
    }
    _restoreLastSyncTime();

    // ⭐ お気に入りフィルターボタン
    const starFilterBtn = document.getElementById("starFilterBtn");
    if (starFilterBtn) {
      starFilterBtn.addEventListener("click", () => {
        historyShowStarredOnly = !historyShowStarredOnly;
        starFilterBtn.classList.toggle("active", historyShowStarredOnly);
        starFilterBtn.textContent = historyShowStarredOnly ? "⭐ お気に入りのみ" : "☆ お気に入り";
        loadHistory(historySearch?.value || "");
      });
    }

    // 詳細フィルター
    const filterDateFrom = document.getElementById("filterDateFrom");
    const filterDateTo   = document.getElementById("filterDateTo");
    const filterConfMin  = document.getElementById("filterConfMin");
    const filterConfMinVal = document.getElementById("filterConfMinVal");
    const filterReset    = document.getElementById("filterReset");
    const applyFilter = () => loadHistory(historySearch?.value || "");
    if (filterDateFrom) filterDateFrom.addEventListener("change", applyFilter);
    if (filterDateTo)   filterDateTo.addEventListener("change",   applyFilter);
    if (filterConfMin) {
      filterConfMin.addEventListener("input", () => {
        if (filterConfMinVal) filterConfMinVal.textContent = filterConfMin.value + "%";
        applyFilter();
      });
    }
    if (filterReset) {
      filterReset.addEventListener("click", () => {
        if (filterDateFrom) filterDateFrom.value = "";
        if (filterDateTo)   filterDateTo.value   = "";
        if (filterConfMin)  { filterConfMin.value = "0"; if (filterConfMinVal) filterConfMinVal.textContent = "0%"; }
        applyFilter();
      });
    }

    // IndexedDBを初期化
    initIndexedDB();

    // ランキング初期読み込み（ページ表示後に非同期で取得）
    loadRanking("all");

    // クラウド同期・復元をグローバルに公開
    window.restoreCloudHistoryFromInput = restoreCloudHistoryFromInput;
    window.openExportModal              = openExportModal;
    window.closeExportModal             = closeExportModal;
    window.executeExport                = executeExport;
    window.openCloudSyncModal           = openCloudSyncModal;
    window.closeCloudSyncModal          = closeCloudSyncModal;
    window.copyCloudUserId              = copyCloudUserId;
    window.loadRanking                  = loadRanking;
    window.toggleStarred                = toggleStarred;
    window.addToComparison              = addToComparison;
    window.removeFromComparison         = removeFromComparison;
    window.clearComparison              = clearComparison;
    window.openComparisonModal          = openComparisonModal;
    window.closeComparisonModal         = closeComparisonModal;
    window.addToSpotifyPlaylist         = addToSpotifyPlaylist;
    window.startSpotifyAuth             = startSpotifyAuth;
    window.loadSpotifyPlaylist          = loadSpotifyPlaylist;
    window.embedSpotifyTrack            = embedSpotifyTrack;
    window.openExportModal              = openExportModal;
    window.closeExportModal             = closeExportModal;
    window.executeExport                = executeExport;
    
    
  } catch (err) {
    console.error('Initialization error:', err);
    if (resultArea) {
      resultArea.innerHTML = `
        <div class="card" style="background:#fee2e2;color:#991b1b;padding:14px;">
          <b>初期化エラー</b><br>
          ${err.message}<br>
          <small>ページを再読み込みしてください</small>
        </div>
      `;
    }
  }
});