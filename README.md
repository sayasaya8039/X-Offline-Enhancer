# X Offline Enhancer

X/Twitter のスレッドを画像・動画ごとオフライン保存し、いつでも読み返せる Chrome 拡張機能。

## 機能

- **スレッド保存** — ワンクリックでスレッド全文（テキスト・画像・動画）を IndexedDB に保存
- **オフライン閲覧** — サイドパネルのリーダービューで保存済みスレッドをいつでも閲覧
- **動画オフライン再生** — video.twimg.com の MP4 を Blob としてローカル保存・再生
- **PiP 動画** — コンテンツスクリプトから Picture-in-Picture ボタンを提供
- **PDF エクスポート** — html2canvas + jsPDF で保存スレッドを PDF 出力
- **全文検索** — 保存スレッドをテキスト・作者名・ハンドル・タグで横断検索
- **選択削除 / 全削除** — 複数スレッドの一括選択削除に対応
- **キャッシュ自動管理** — ストレージ上限（MB）と TTL（日数）に基づく自動クリーンアップ
- **X Pro 対応** — x.com / twitter.com に加え pro.x.com のマルチカラムレイアウトにも対応

## インストール

1. このリポジトリをクローンまたはダウンロード
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」を ON にする
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. `X_Offline_Enhancer` フォルダを選択

## 使い方

1. X/Twitter でスレッドを開く
2. 各ツイートに表示される **保存ボタン** をクリック
3. ツールバーの拡張アイコンをクリックしてサイドパネルを開く
4. 保存済みスレッド一覧から選択してリーダービューで閲覧

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  x.com / twitter.com / pro.x.com                    │
│  ┌───────────────────────────────────────────┐      │
│  │  content_script.js                        │      │
│  │  - 保存ボタン / PiP ボタン注入            │      │
│  │  - ツイートデータ抽出                     │      │
│  │  - 動画 URL 検出（Performance API）       │      │
│  └──────────────┬────────────────────────────┘      │
└─────────────────┼───────────────────────────────────┘
                  │ chrome.runtime.sendMessage
┌─────────────────▼───────────────────────────────────┐
│  service_worker.js (ES Module)                      │
│  - メッセージルーティング                           │
│  - IndexedDB CRUD（lib/db-esm.js）                  │
│  - 動画フェッチ & Blob 保存                         │
│  - キャッシュクリーンアップ（Alarms API）           │
│  - PDF 生成指示 → offscreen.js                      │
│  - サイドパネル / コンテンツスクリプトへのブロードキャスト │
└─────────────────┬───────────────────────────────────┘
                  │ chrome.runtime.sendMessage
┌─────────────────▼───────────────────────────────────┐
│  sidepanel.js (ES Module)                           │
│  - スレッド一覧表示 / 検索                          │
│  - リーダービュー（画像・動画オフライン再生）       │
│  - 選択モード / 一括削除                            │
│  - 設定パネル（容量上限・TTL）                      │
│  - PDF エクスポート                                 │
└─────────────────────────────────────────────────────┘
```

## ファイル構成

```
X_Offline_Enhancer/
├── manifest.json          # Manifest V3 設定
├── content_script.js      # コンテンツスクリプト（保存ボタン・PiP・データ抽出）
├── content_script.css     # コンテンツスクリプト用スタイル
├── service_worker.js      # Service Worker（メッセージハブ・DB操作・動画取得）
├── sidepanel.html         # サイドパネル HTML
├── sidepanel.js           # サイドパネルロジック（一覧・リーダー・設定）
├── sidepanel.css          # サイドパネルスタイル
├── sidepanel-init.js      # CSP 準拠のモジュール読み込みフォールバック
├── offscreen.html         # Offscreen Document（PDF 生成用）
├── offscreen.js           # html2canvas + jsPDF による PDF 生成
├── lib/
│   ├── db-esm.js          # IndexedDB ヘルパー（スレッド・動画 Blob CRUD）
│   ├── db.js              # globalThis ラッパー
│   └── utils-esm.js       # 共通ユーティリティ
├── vendor/
│   ├── html2canvas.min.js # html2canvas ライブラリ
│   └── jspdf.umd.min.js   # jsPDF ライブラリ
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 権限

| 権限 | 用途 |
|------|------|
| `sidePanel` | サイドパネル API |
| `storage` | 設定の保存 |
| `scripting` | コンテンツスクリプト動的注入 |
| `activeTab` | 現在のタブ情報取得 |
| `tabs` | タブ URL 確認・メッセージ送信 |
| `offscreen` | PDF 生成用 Offscreen Document |
| `alarms` | 定期キャッシュクリーンアップ（6 時間ごと） |

### ホスト権限

| ドメイン | 用途 |
|---------|------|
| `x.com`, `twitter.com`, `pro.x.com` | コンテンツスクリプト注入・データ取得 |
| `pbs.twimg.com`, `abs.twimg.com` | 画像のオフライン保存 |
| `video.twimg.com` | 動画のオフライン保存 |

## データストレージ

- **IndexedDB** (`XOfflineDB_v1`)
  - `threads` ストア — スレッドデータ（テキスト・画像 base64 キャッシュ）
  - `video_blobs` ストア — 動画 Blob データ（スレッド ID + インデックスで管理）
- **chrome.storage.local** — 設定（容量上限・TTL）

## 技術スタック

- Chrome Extension Manifest V3
- ES Modules（Service Worker / Side Panel）
- IndexedDB（構造化データ + Blob ストレージ）
- Side Panel API
- Offscreen API（DOM 操作が必要な PDF 生成）
- Performance API（動画 URL 検出）
- html2canvas + jsPDF（PDF エクスポート）

## ライセンス

MIT
