# 🎵 Trackora `v3.3.0`

ブラウザだけで完結する楽曲識別 Web アプリ。  
Cloudflare Pages（フロントエンド）+ Cloudflare Workers（API プロキシ）の無料プランで動作します。

---

## 概要

音声・動画ファイルをアップロードするか、マイクで録音するだけで、楽曲を自動識別します。識別後は MusicBrainz による詳細メタデータ取得、YouTube 動画の埋め込み再生、Apple Music / Spotify プレビュー、履歴統計ダッシュボードまで一気通貫で行います。すべての処理は Cloudflare 無料プランの範囲内で動作します。

一応 HTML・JS・CSS をダウンロードして、そのままローカルで実行すれば私の API キーを使ってテストすることができます。ただし無料アカウントなので考えて使ってください。私も日常的に使っているので API を切られると悲しみます。推奨は自前の環境を構築することです。

---

## 目次

1. [ファイル構成](#ファイル構成)
2. [動作環境](#動作環境)
3. [セットアップ](#セットアップ)
4. [機能一覧](#機能一覧)
   - [音声入力](#音声入力)
   - [音声前処理パイプライン](#音声前処理パイプライン)
   - [楽曲認識（ACRCloud）](#楽曲認識acrcloud)
   - [複数候補の表示・選択](#複数候補の表示選択)
   - [信頼度スコア表示](#信頼度スコア表示)
   - [ISRC / UPC 表示](#isrc--upc-表示)
   - [クリップボードコピー](#クリップボードコピー)
   - [ストリーミングリンク](#ストリーミングリンク)
   - [プレビューセクション](#プレビューセクション)
   - [シェアカード生成](#シェアカード生成)
   - [MusicBrainz 詳細情報](#musicbrainz-詳細情報)
   - [Wikipedia アーティスト概要](#wikipedia-アーティスト概要)
   - [アルバムアート操作](#アルバムアート操作)
   - [YouTube 埋め込み再生](#youtube-埋め込み再生)
   - [認識履歴](#認識履歴)
   - [履歴統計ダッシュボード](#履歴統計ダッシュボード)
   - [ダークモード](#ダークモード)
   - [キーボードショートカット](#キーボードショートカット)
   - [デバッグログパネル](#デバッグログパネル)
5. [Worker エンドポイント仕様](#worker-エンドポイント仕様)
6. [環境変数](#環境変数)
7. [アーキテクチャ](#アーキテクチャ)
8. [バージョン履歴](#バージョン履歴)
9. [ライセンス](#ライセンス)

---

## ファイル構成

```text
├── index-stable.html   ページ本体（HTML 構造）
├── style.css           全スタイル（ダーク / ライトモード対応）
├── main-stable.js      フロントエンドロジック全体
└── worker.js           Cloudflare Workers（API プロキシ）
```

---

## 動作環境

- モダンブラウザ（Chrome / Firefox / Safari / Edge 等 最新版）
- Cloudflare 無料プラン（Workers・Pages）
- Web Audio API 対応デバイス（録音機能を使う場合）

---

## セットアップ

### 1. Cloudflare Worker をデプロイ

1. Cloudflare ダッシュボード → **Workers & Pages** → 「アプリケーションを作成」
2. Worker を作成し `worker.js` の内容を貼り付けてデプロイ
3. **設定 → 変数** から環境変数を追加（暗号化あり）→ [環境変数](#環境変数) 参照

### 2. Cloudflare Pages にフロントエンドをデプロイ

1. **Workers & Pages** → 「アプリケーションを作成」→「Pages」→「ファイルをアップロード」
2. `index-stable.html` / `style.css` / `main-stable.js` の 3 ファイルをアップロード

### 3. Worker URL を設定

`main-stable.js` 冒頭の `WORKER_URL` を Worker の URL に変更します。

```js
const WORKER_URL = "https://your-worker.your-subdomain.workers.dev/";
```

---

## 機能一覧

### 音声入力

ファイル入力とマイク録音の 2 系統に対応します。

#### ファイル入力

- ドロップゾーン（`<label id="dropZone">`）がドラッグ＆ドロップとクリック選択を兼用
- クリックで `<input type="file">` ダイアログを開く（`for="fileInput"` 連携）
- ドロップ時は `DataTransfer → input.files` を同期
- 選択後、ファイル名とサイズ（MB）をアニメーション付きカードで表示
- 対応形式：`audio/*`・`video/*`（ブラウザが Web Audio API でデコードできる全形式）

#### マイク録音

- 接続中のマイクデバイスを自動列挙（`enumerateMicrophones()`）してドロップダウンに表示
- 録音時間を 3 / 5 / 8 / 10 秒から選択
- 録音中はリアルタイム**波形ビジュアライザー**が周波数バーを描画し、プログレスバーで残り時間を表示
- 録音後 `<audio>` タグでプレビュー再生が可能
- 「この録音を判定」ボタンで同一の前処理パイプラインへ投入

---

### 音声前処理パイプライン

`preprocessAudio(file)` が送信前に自動実行します。

```text
入力ファイル
  │
  ├─ 500 KB 未満の WAV/MP3 ─→ そのまま送信（前処理スキップ）
  │
  ▼
① ファイル種別チェック（audio/* / video/* 以外はエラー）
② 極小ファイルチェック（2,000 bytes 未満はエラー）
③ AudioContext でデコード（失敗時は生ファイルをフォールバック送信）
④ 先頭 10 秒にトリミング（TRIM_SEC = 10）
⑤ 複数チャンネルをモノラルにミックスダウン（各チャンネルの平均）
⑥ 16,000 Hz にダウンサンプル（線形補間 downsample()）
⑦ 16-bit PCM WAV にエンコード（encodeWAV()）
⑧ 900 KB 超の場合はエラー
  │
  ▼
Worker へ FormData POST
```

各ステップの結果はデバッグログに詳細出力されます（ファイルサイズ・サンプルレート・圧縮率・所要時間など）。

---

### 楽曲認識（ACRCloud）

`send()` → `preprocessAudio()` → Worker POST → `showResult()` の流れで動作します。

**Worker 側（`worker.js` メイン処理）：**

1. FormData からバイナリ音声を取得
2. `env.ACR_ACCESS_KEY` / `env.ACR_ACCESS_SECRET` で HMAC-SHA1 署名を生成（Web Crypto API）
3. ACRCloud `/v1/identify` へ POST
4. `_debug` フィールド付きでレスポンスを返却

**フロント側：**

- `status.code !== 0` → エラーカード表示
- 成功 → `json.acr.metadata.music`（候補リスト）を `showResult()` に渡す

---

### 複数候補の表示・選択

ACRCloud は最大 5 件の候補を返します。それぞれをカード形式で表示し、任意に切り替え可能です。

**関数：`showResult()` / `renderCandidateCard()` / `activateCandidate()`**

- 最有力候補（index 0）は展開状態で表示
- 2 件目以降は「▶ 詳細を見る」で折りたたみ展開
- 「この候補を使う →」ボタン押下で：
  - カードをアクティブ状態（青ボーダー）に切り替え
  - MusicBrainz / iTunes / YouTube / Wikipedia の取得を再起動
  - 履歴に記録

候補一覧は `_candidateList` にキャッシュされるため、`activateCandidateByIndex(i)` でいつでも再選択できます。

---

### 信頼度スコア表示

`buildConfidenceBar(conf)` が各候補カードにアニメーション付きプログレスバーを描画します。

| 信頼度 | 色 | ラベル |
|---|---|---|
| 90% 以上 | 🟢 緑 | 高信頼 |
| 70〜89% | 🟡 黄 | 中信頼 |
| 69% 以下 | 🔴 赤 | 要確認 |

表示される % は `pseudoConfidence(score, index)` による推定値（ACRCloud 生スコアに順位ペナルティを加算）です。ACRCloud の生スコア（0〜100）は「ACRCloud score: XX」として小さく併記されます。

---

### ISRC / UPC 表示

ACRCloud レスポンスの `external_ids` に値が含まれる場合、候補カードに ISRC・UPC バッジを表示します。

- **ISRC バッジ**（青）：クリックすると MusicBrainz 検索ページへ直接リンク
- **UPC バッジ**（緑）：バーコード番号を表示
- MusicBrainz セクションでは `isrcs` 配列を全件表示

---

### クリップボードコピー

各候補カードの「📋 コピー」ボタンで曲情報をクリップボードにコピーします。

**関数：`copyTrackInfo(btn)`**

コピー形式：

```text
アルバムあり: "曲名 / アーティスト（アルバム名）"
アルバムなし: "曲名 / アーティスト"
```

- `navigator.clipboard.writeText()` を使用
- 非対応環境は `document.execCommand('copy')` にフォールバック
- コピー後 2 秒間ボタンが「✅ コピー済み」に変化

---

### ストリーミングリンク

`buildStreamingLinks(title, artist, containerId, m)` が各候補カードに生成します。

| ボタン | 遷移先 | 備考 |
|---|---|---|
| 🎬 MV | YouTube 検索（"official music video" 付き） | 常時 |
| 🎵 Spotify | track ID があれば**直接リンク**、なければ検索 | ACRCloud `external_metadata` から取得 |
| 🎶 Deezer | track ID があれば**直接リンク**、なければ検索 | ACRCloud `external_metadata` から取得 |
| 🍎 Apple Music | iTunes `trackViewUrl` に自動差し替え | iTunes 取得後に更新 |
| 📋 コピー | クリップボード | → [クリップボードコピー](#クリップボードコピー) |
| 📤 共有 | Web Share API / クリップボード | 非対応環境はクリップボードにフォールバック |

Spotify / Deezer は track ID が取得できた場合に直接リンクボタン（グラデーション強調）となり、なければ検索 URL にフォールバックします。Apple Music も iTunes 取得後に `trackViewUrl`（直接リンク）へ差し替えられ `.stream-apple-direct` クラスが追加されスタイルも変化します。

---

### プレビューセクション

認識成功後、YouTube の下に「🎧 プレビュー」セクションが表示されます。

| プレーヤー | 説明 |
|---|---|
| 🍎 iTunes プレビュー | iTunes API から取得した 30 秒プレビューを `<audio>` で再生。Apple Music の「開く」リンク付き |
| 🎵 Spotify 埋め込み | Spotify track ID があれば iframe 埋め込みプレーヤーを表示。Spotify アカウントで全曲再生可能 |

ダークモード切替時に Spotify プレーヤーのテーマも自動で連動します。どちらも取得できない場合はセクション自体が非表示になります。

---

### シェアカード生成

各候補カードの「🖼️ シェアカードを作成」ボタンでシェア用画像（600×300 px）を Canvas で生成します。

- アルバムアートをぼかした背景（アートなしの場合はグラデーション背景）
- タイトル / アーティスト / アルバム名を重ねて表示
- アプリバージョンのフッター
- 「💾 画像を保存」で PNG ダウンロード
- 「📤 共有」で Web Share API 経由の共有（画像ファイルごと共有可能なブラウザのみ）
- `Esc` キーでモーダルを閉じることも可能

---

### MusicBrainz 詳細情報

`fetchMusicBrainz(title, artist)` → `displayMusicBrainzInfo(r)` で取得・表示します。

**Worker 側（`handleMusicBrainz()`）：**

- クエリ：`recording:"タイトル" AND artist:"アーティスト"`
- `inc` パラメータ：`artists+releases+tags+ratings+genres+isrcs+url-rels+annotation+artist-credits+work-rels`
- `url-rels` から Wikidata ID・YouTube URL を抽出してレスポンスに含める

**フロント表示項目：**

| セクション | 内容 |
|---|---|
| 📀 基本情報 | Recording ID / タイトル / アーティスト / 長さ / MBスコア / ISRC 一覧 / 評価（★表示・投票数）/ アノテーション / 備考 |
| 💿 リリース情報 | アルバム名 / リリース日 / 国 / タイプ / ステータス / バーコード |
| 💿 全リリース | 最大 10 件の詳細（折りたたみ表示） |
| 🎵 トラック情報 | トラック番号 / ディスク番号 / メディア形式 |
| 🏷️ レーベル | レーベル名 / カタログ番号 |
| 🎼 ジャンル | MusicBrainz ジャンルタグ（投票数付き） |
| 🏷️ タグ | ユーザータグ（投票数付き） |
| 🎤 アーティスト詳細 | 複数アーティストの場合に各アーティスト名・結合フレーズ・ソート名を列挙 |
| 🎼 Works | 楽曲タイトル / タイプ / 作曲者 / 作詞者 |
| 🌐 外部リンク | Wikidata・公式サイト等の url-rels（YouTube 除外） |
| 📖 Wikipedia | → [Wikipedia アーティスト概要](#wikipedia-アーティスト概要) |
| 🍎 iTunes | Apple Music で開くリンク（プレビューはプレビューセクションへ移動） |
| 🔗 MusicBrainz | MusicBrainz 本家へのリンク |

---

### Wikipedia アーティスト概要

`fetchWikipedia(artist, wikidataId)` → `displayWikipediaInfo(data)` が MusicBrainz セクション内にアーティストの Wikipedia 概要を挿入します。

**Worker 側（`handleWikipedia()`）の処理フロー：**

```text
1. wikidata_id があれば Wikidata API でタイトルを解決
   jawiki → enwiki の順でフォールバック

2. タイトルが得られなければアーティスト名で Wikipedia 直接検索
   ja.wikipedia.org → en.wikipedia.org の順でフォールバック

3. Wikipedia REST API でサマリーを取得
   GET https://{ja|en}.wikipedia.org/api/rest_v1/page/summary/{title}

返却: { title, summary, url, language, thumbnail }
```

**フロント表示：** 言語バッジ（日本語版 / 英語版）・サムネイル画像・概要テキスト・「Wikipedia で読む」リンク

---

### アルバムアート操作

アルバムアートの右下に操作ボタンが表示されます。

| ボタン | 機能 | 実装 |
|---|---|---|
| 💾 DL | オリジナル画像をダウンロード | `downloadArtByElement()` → `<a download>` |
| 🔗 URL | 画像 URL をクリップボードにコピー | `copyArtUrlByElement()` → `navigator.clipboard` |
| 🖼️ 開く | 新しいタブで画像を開く | `openArtNewTabByElement()` → `window.open()` |
| 画像クリック | 表示サイズをトグル（300px ↔ 100%） | `toggleArtSize(img)` |

画像の優先順位（高品質優先）：iTunes 1200px → Spotify → Deezer

---

### YouTube 埋め込み再生

`fetchAndShowYouTube(title, artist, mbYoutubeUrl)` が YouTube 動画を検索・埋め込みます。

**処理フロー：**

```text
① MusicBrainz の url-rels に YouTube URL が含まれる場合
   → extractYouTubeVideoId() で video ID を取得して直接埋め込み（API 使用量ゼロ）

② 含まれない場合
   → Worker /youtube へ POST
   → YouTube Data API v3 で最大 5 件検索
     （クエリ: "アーティスト タイトル official music video"）
```

**埋め込み実装（`playYTVideo()`）：**

- YouTube IFrame Player API を使用
- 埋め込み禁止エラー（コード 101 / 150 / 153）で次の候補に自動スキップ（`tryNextVideo()`）
- サムネイルクリックでプレーヤーを起動（`renderYouTubeEmbed()`）

> JASRAC 等に登録されている楽曲は埋め込みが禁止されているケースが多いため、YouTube 埋め込みで視聴しようとすると弾かれることがあります。

---

### 認識履歴

`IndexedDB`（DB 名: `music-history`）に認識結果を自動保存します。

**保存タイミング：** `activateCandidate()` — 候補をアクティベートするたびに記録  
**保存データ：** `{ title, artist, confidence, time }`

履歴リストは最大高さ 320px でスクロール可能です。

| 操作 | 説明 |
|---|---|
| キーワード検索 | 曲名・アーティスト名でインクリメンタルサーチ |
| 履歴クリック | `loadHistoryItem()` — MusicBrainz / iTunes / YouTube / Wikipedia を再取得。ストリーミングリンク・シェアカードボタンも復元 |
| 1 件削除 | 確認ダイアログ付きで削除 |
| 全クリア | 確認ダイアログ後に全件削除 |
| エクスポート | `music-history-{timestamp}.json` としてダウンロード |

---

### 履歴統計ダッシュボード

履歴が 1 件以上ある場合、履歴セクションの上部に折りたたみ式の統計パネルが表示されます。外部ライブラリ不使用・Canvas 自前描画です。

| グラフ | 内容 |
|---|---|
| よく聴くアーティスト TOP5 | 横棒グラフ |
| 時間帯別の認識回数 | 縦棒グラフ（0〜23 時） |
| 直近 7 日間の認識推移 | 折れ線グラフ |

---

### ダークモード

- 画面左下の「🌙 / ☀️」ボタンで手動切替（`toggleTheme()`）
- OS のシステム設定を初期値として自動適用
- 選択状態は `localStorage['theme']` に保存・復元（`initTheme()`）
- CSS カスタムプロパティを `body.dark` クラスの付け外しで全要素一括切り替え

---

### キーボードショートカット

画面左下の「⌨️」ボタン、または `?` キーでヘルプパネルを表示できます。テキスト入力中は全ショートカットが無効化されます。

| キー | 動作 |
|---|---|
| `R` | 録音開始 / 停止 |
| `Space` | YouTube 再生 / 一時停止 |
| `C` | アクティブ候補の曲情報をコピー |
| `D` | ダークモード切替 |
| `?` | ショートカットヘルプパネルを表示 / 非表示 |
| `Esc` | 開いているパネル・モーダルを閉じる |

---

### デバッグログパネル

「🐛 デバッグログ」セクションのトグルで有効化します。各 API コールの内部状態を構造化カード形式でリアルタイム表示します。

**フェーズ別カラーコード：**

| フェーズ | 色 | 対象 |
|---|---|---|
| 🟢 前処理 | 緑 | 音声デコード・トリミング・WAV 変換 |
| 🟣 ACRCloud | 紫 | 楽曲認識 API |
| 🔵 MusicBrainz | 青 | 楽曲メタデータ API |
| 🟠 iTunes | オレンジ | iTunes Search API |
| 🔴 YouTube | 赤 | YouTube Data API v3 |
| ⚪ Wikipedia / システム | グレー | Wikipedia / その他 |

**各 API コールで流れるログ：**

```text
1. フェーズ: Worker へ送信         ← リクエストパラメータ
2. フェーズ: Worker レスポンス受信  ← 要約 + 生レスポンスオブジェクト全体
3. フェーズ: レスポンスペイロード（生）← Worker からの JSON 全体（_debug 除外）
4. フェーズ: Worker 受信メタ       ← Worker がリクエストで受け取った内容
5. フェーズ: →上流 API コール      ← Worker→外部 API への送信情報（URL・クエリ・所要時間）
6. フェーズ: ←上流 API レスポンス  ← 外部 API の生レスポンス（raw_best_match / raw_items 等）
```

**主な生データフィールド：**

| API | 生データフィールド |
|---|---|
| ACRCloud | `raw_acr`（ACRCloud レスポンス全体）・`raw_music`（全候補配列） |
| MusicBrainz | `recording`（Recording 全体）・`raw_recording`（生 API レスポンス） |
| iTunes | `bestMatch`・`results_top3`・`raw_best_match`・`raw_results_top5` |
| YouTube | `videos`（動画配列全体）・`raw_items`（API レスポンスの items 配列） |
| Wikipedia | `summary_preview`（300 文字）・`raw_extract`・`raw_thumbnail`・`content_urls` |

| ボタン | 説明 |
|---|---|
| カードヘッダークリック | JSON の折りたたみ / 展開 |
| すべて展開 / 折りたたむ | 全カードに一括適用 |
| 📥 JSON エクスポート | セッション全ログを `debug_{timestamp}.json` としてダウンロード |
| 🗑 クリア | 表示中のエントリを全削除 |

エラー（赤）・警告（黄）カードは自動で展開表示されます。

---

## Worker エンドポイント仕様

| パス | メソッド | リクエスト | 用途 |
|---|---|---|---|
| `/` | POST | FormData（`file`） | ACRCloud 楽曲認識 |
| `/itunes` | POST | JSON `{ title, artist }` | iTunes Search API プロキシ（プレビュー URL・アートワーク・trackViewUrl） |
| `/musicbrainz` | POST | JSON `{ title, artist }` | MusicBrainz Recording 検索 |
| `/youtube` | POST | JSON `{ title, artist }` | YouTube Data API v3 検索 |
| `/wikipedia` | POST | JSON `{ artist, wikidata_id? }` | Wikidata + Wikipedia サマリー取得 |
| `/spotify` | POST | JSON `{ title, artist, track_id? }` | Spotify Web API トラック情報取得（Client Credentials フロー） |
| `/spotify/auth` | GET | クエリ `redirect_uri` | Spotify OAuth 認可 URL を返す |
| `/spotify/callback` | POST | JSON `{ code, redirect_uri }` | 認可コードをアクセストークンに交換 |
| `/spotify/playlist/add` | POST | JSON `{ access_token, title, artist, track_uri? }` | プレイリスト「Trackora」に楽曲を追加 |
| `/cloud/sync` | POST | JSON `{ user_id, title, artist, album?, genre?, isrc?, confidence, recognized_at }` | D1 に認識履歴を保存 |
| `/cloud/history` | POST | JSON `{ user_id, limit? }` | 自分の履歴を D1 から取得 |
| `/cloud/ranking` | GET | クエリ `?period=all\|month` | 全ユーザーの認識回数ランキング |
| `/cloud/ranking/user` | POST | JSON `{ user_id }` | 自分の認識回数 TOP10 |

`/spotify` は `track_id` が指定されている場合は直接トラック取得、ない場合はキーワード検索にフォールバックします。

---

## 環境変数

| 変数名 | 必須 | 用途 |
|---|---|---|
| `ACR_ACCESS_KEY` | ✅ | ACRCloud 認証キー |
| `ACR_ACCESS_SECRET` | ✅ | ACRCloud HMAC-SHA1 署名用シークレット |
| `ACR_HOST` | ✅ | ACRCloud ホスト名 |
| `YOUTUBE_API_KEY` | ✅ | YouTube Data API v3 キー |
| `SPOTIFY_CLIENT_ID` | ✅ | Spotify Developer Dashboard のクライアント ID（トラック情報取得・プレイリスト連携） |
| `SPOTIFY_CLIENT_SECRET` | ✅ | Spotify Developer Dashboard のクライアントシークレット |

すべて Cloudflare Worker の「変数とシークレット」に設定してください（**シークレットとして暗号化を推奨**）。

---

## D1 セットアップ（クラウド同期・ランキング機能）

クラウド同期・ランキング機能は Cloudflare D1（SQLite）を使用します。Cloudflare 無料プランで動作します。

### 手順

1. **D1 データベース作成**  
   Cloudflare ダッシュボード → Workers & Pages → D1 → 「データベースを作成」  
   データベース名を `music-history` にして作成します。

2. **Worker にバインディングを追加**  
   Workers → 対象 Worker → **設定** → **バインディング** → 「追加」→ D1 データベース  
   変数名 `DB`、データベースに `music-history` を選択して保存します。

3. **テーブルは自動作成**  
   楽曲を1件認識すると、Worker が自動で `music_history` テーブルとインデックスを作成します。手動での SQL 実行は不要です。

### クラウド同期のしくみ

- 楽曲認識のたびにブラウザが自動で `POST /cloud/sync` を呼び出し D1 に保存します。
- ユーザー ID はログイン不要の**匿名 UUID** で、ブラウザの `localStorage` に保存されます。
- 別端末で同じ履歴を使いたい場合は、履歴セクションの「☁️ クラウド同期」ボタンを押し、表示された同期 ID をもう一方の端末で入力して「復元」を押してください。

---

## アーキテクチャ

```text
ブラウザ（Cloudflare Pages）
  │
  ├─ 音声前処理（Web Audio API）
  │     trimming → mono mixdown → downsample → 16-bit PCM WAV encode
  │
  ├─ Canvas 描画（外部ライブラリ不使用）
  │     波形ビジュアライザー / 統計グラフ / シェアカード生成
  │
  ├─ IndexedDB（認識履歴・ブラウザ内完結）
  │
  └─ Cloudflare Worker（API プロキシ・認証情報の隠蔽）
        │
        ├─ /             → ACRCloud identify-ap-southeast-1.acrcloud.com
        ├─ /itunes       → itunes.apple.com/search
        ├─ /musicbrainz  → musicbrainz.org/ws/2/recording
        ├─ /youtube      → googleapis.com/youtube/v3/search
        ├─ /wikipedia    → wikidata.org → {ja|en}.wikipedia.org/api/rest_v1
        ├─ /spotify      → accounts.spotify.com（トークン）→ api.spotify.com/v1/tracks または /search
```

Worker は CORS ヘッダーを付与することで、ブラウザから直接呼べない外部 API へのリクエストをプロキシします。API キー・シークレットは Worker の環境変数に格納されるため、ブラウザには一切漏洩しません。

---

## バージョン履歴

| バージョン | 内容 |
|---|---|
| — | これ以前は忘れた |
| v2.7.1 | デバッグパネル・音声前処理・User-Agent 統一 |
| v2.8.0 | 信頼度バー / 複数候補選択 / コピーボタン / ストリーミングリンク強化 / Wikipedia 統合 |
| v2.8.1 | デバッグログ生データ化（Worker `_debug` 拡充・`debugLogWorker` 再設計・フロント各ログ更新） |
| v2.8.2 | デバッグログ完全生データ化（iTunes / YouTube / Genius / Wikipedia の Worker 側 `upstream_response` に全生レスポンス追加） |
| v2.9.0 | Spotify / Deezer 直接リンク、ISRC / UPC 表示、Spotify 埋め込みプレーヤー、キーボードショートカット追加 |
| v2.9.1 | 録音波形ビジュアライザー、履歴統計ダッシュボード、シェアカード生成追加 |
| v2.9.4 | シェアカード・ショートカットヘルプ モーダル表示バグ修正（CSS `.is-open` クラス方式に統一）、ショートカットヘルプ FAB ボタン追加、iTunes プレビューを Spotify と同じプレビューセクションに統合、旧世代 `console.log` 廃止、WCAG AA コントラスト全 22 件合格 |
| v2.9.5 | Spotify 埋め込みプレーヤー表示不具合修正（iframe に `allowtransparency` / `sandbox` 属性を追加） |
| v2.10.0 | 履歴復元の完全化（ストリーミングリンク・iTunes プレビュー・シェアカードボタン対応）、履歴リストにスクロール制限（最大高さ 320px）、MusicBrainz 未表示項目追加（評価・アノテーション・アーティスト詳細・Works 作曲者/作詞者・外部 URL 一覧） |
| v2.11.0 | Spotify Web API 統合（Client Credentials フロー・プレビュー URL 補完・メタデータ補完）、iTunes 表記を Apple Music に統一、録音判定エラー修正（`audio/webm` MIME タイプ未設定）、Apple Music プレビューの重複削除（MusicBrainz 詳細内 audio タグを削除しプレビューセクションに一本化）、アルバムアート操作修正（動的追加時にコントロールボタンを含む・ダウンロードを fetch+blob 方式に変更）、シェアカード情報量増加（リリース日・再生時間・ジャンル・ISRC 表示）・JPEG / PNG 形式選択追加、YouTube 埋め込みエラーのデバッグログを閉じた状態で表示、`cand-activate-btn` ホバー色バグ修正 |
| v2.12.0 | シェアカードフォーマット選択をカスタムセグメントコントロール化（CSS デザイン統一）、シェアカードモーダルにメタデータ取得元バッジ追加（ホバーでソースと説明を表示）、`setShareFormat` / `renderMetaSourceBadges` 関数追加 |
| v2.12.1 | ビジュアルフィンガープリント追加：前処理後の16kHzモノラルPCMをGoertzelアルゴリズムで対数周波数軸スペクトログラムに変換しCanvasヒートマップ表示。判定ボタン下に自動表示・時間軸/周波数軸ラベル付き。ACRCloudへ実際に送っているデータを可視化 |
| v2.12.2 | Spotify Web API 連携追加（`fetchSpotifyTrackInfo`）：Worker `/spotify` エンドポイント経由でトラック詳細・プレビューURL取得・`currentTrackInfo` へのメタデータ補完。Apple Music プレビューがない場合に Spotify 30秒プレビューを代替表示 |
| **v2.12.3** | Spotify iframe の非推奨属性削除、YouTube IFrame API `origin` パラメータ追加、インライン SVG favicon 追加、worker.js にアーキテクチャコメント追加 |
| **v3.0.0** | メジャーバージョンアップ。クラウド同期・ランキング機能追加（匿名 UUID、`POST /cloud/sync`、`GET /cloud/ranking`）。 |
| **v3.0.1** | クラウド同期 GUI モーダル追加。別端末の同期 ID を入力欄に貼り付けるだけで履歴を復元可能に。 |
| **v3.0.2** | User-Agent 文字列をグローバル定数 `UA` に統一。全外部 API（iTunes / MusicBrainz / YouTube / Genius / Wikipedia）が同一の UA を使用するようになった。 |
| **v3.0.6** | データストアを **Cloudflare D1 (SQLite)** に移行。外部 DB 不要・バインディング `DB` のみで動作。 |
| **v3.0.7** | `d1Init()` のテーブル作成を `prepare().run()` に変更（D1 複数行 SQL エラー解消）。 |
| **v3.0.8** | お気に入り機能追加（⭐ トグル・IndexedDB `starred` フラグ・フィルターボタン+件数バッジ）。エクスポートモーダル追加（CSV / JSON 選択・お気に入りのみオプション・件数表示）。5分おき定期クラウド自動同期 + 差分インポート + トースト通知。最終同期日時を localStorage に保存してモーダルに表示。 |
| **v3.1.0** | クラウド同期モーダルに「自分の認識回数 TOP10」ランキングを追加（`loadUserRanking()`）。同期済み件数・ユーザーランキングを `Promise.all` で並列取得。 |
| **v3.1.1** | User-Agent を `MusicRecognizer-RT2231.var/3.1.1` に更新。 |
| **v3.1.2** | `POST /cloud/ranking/user` エンドポイントを worker.js に実装。クラウド同期モーダルの「自分の認識回数 TOP10」が正しく表示されるようになった。 |
| **v3.1.3** | JS 構文エラー修正（`_importCloudHistory` の JSDoc `/**` 欠落）。README のコードブロック言語タグ追加・末尾改行修正。LICENSE.md の Markdown 書式修正。`style.css` に標準プロパティ `line-clamp` を追記。 |
| **v3.2.0** | **5機能追加**: ① D1 に `album` / `genre` / `isrc` カラム追加（自動マイグレーション）、`syncToCloud` も送信。② 履歴の詳細フィルター（日付範囲・信頼度スライダー・リセット）。③ 曲情報比較機能完成（最大5曲を表形式で比較・差異ハイライト・FABボタン）。④ オフライン対応（Service Worker `sw.js`・Cache First + Stale While Revalidate）。⑤ Spotify プレイリスト連携（OAuth・`/spotify/auth` + `/callback` + `/playlist/add` Worker 実装・`spotify-callback.html`）。 |
| **v3.2.2** | 歌詞取得を Genius に戻した（v3.2.1 の LyricFind 変更を取り消し）。 |
| **v3.2.3** | 歌詞取得機能（Genius）を完全削除。`/genius` エンドポイント・`fetchLyrics`・`lyricsSection` をすべて除去。 |
| **v3.2.4** | `POST /spotify` エンドポイントを実装。Client Credentials フローでトークンを取得し、`track_id` があれば直接取得、なければ title+artist 検索。`fetchSpotifyTrackInfo` が正常動作するようになった。 |
| **v3.2.5** | v3.2.5（通信量削減）で失われた機能を復元: MusicBrainz `annotation`・`ratings` を `inc=` に戻す、Wikipedia フォールバック検索（ja→en）を復元、Spotify トラック取得を常時実行に戻す。 |
| **v3.2.6** | **機能を削らない通信量削減**: セッション内メモリキャッシュを全API（MusicBrainz / iTunes / Wikipedia / Spotify / YouTube）に導入（TTL 30分・同一曲の再認識でフェッチ不要）。Spotify Client Credentials トークンをモジュールスコープでキャッシュ。全上流リクエストに `Accept-Encoding: gzip` を追加。クラウド自動同期をバックグラウンドタブ時スキップ。 |
| **v3.2.7** | YouTube 埋め込み修正: `_ytPendingPlay` と `setTimeout` リトライを組み合わせてロード前・ロード後いずれでも確実に再生。Spotify embed の `sandbox` 属性を削除（Cookie・認証を阻害していた）。 |
| **v3.2.8** | YouTube 黒画面修正: `YT.Player` に `width`・`height` を明示、`mute: 1` + `autoplay: 1` で Autoplay Policy を回避、DOM 確定待ちを 200ms → 500ms に延長。 |
| **v3.3.0** | アプリ名を「音楽認識ツール」から **Trackora** に統一（UI・プレイリスト名・Worker コメント含む）。**PWA 対応**（`manifest.json` 追加・ホーム画面インストール可能）。**Spotify プレイリスト表示機能**追加（`GET /spotify/playlist` Worker エンドポイント・トラック一覧 UI・クリックで Spotify embed 再生・ログイン済み時は自動表示）。 |

---

## ライセンス

本プロジェクトは MIT ライセンスの下で提供されています。詳しくは LICENSE.md をご覧ください。

---

## 開発環境について

コードの作成はChrome上のClaudeで一旦Web版のVSCodeにいれて**ChromeOS** Chromeでローカルファイルを開いて検証しています。本体が IntelN4020 の メモリ**4 GB** というわけのわからないほどスペックの低い端末を使っています。助けて、めもりたりません、めもりたかいです、かなしいです

---

一部機能ファイルを除き Claude Sonnet 4.5 / Sonnet 4.6 および双方の拡張思考バージョンを使用して生成されました。
