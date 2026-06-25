# アーキテクチャ概要

3ファイル・3層構成（Electron標準パターン）。

## electron-main.js — Electronメインプロセス
- 外部ツール（ffmpeg / yt-dlp 等）の存在確認・自動ダウンロード（`checkSystemTool`, `setupTools`, `downloadFile`）
- 自動アップデーター（`setupAutoUpdater`）
- ローカルExpressサーバーの起動とウィンドウ生成（`startServer`, `createWindow`, `getFreePort`, `waitForServer`）

## server.js — Express API（127.0.0.1バインド）
- 設定・メタデータ・ゴミ箱の永続化（`loadSettings`/`saveSettings`, `loadMeta`/`saveMeta`, `loadTrash`/`saveTrash`）
- フォルダスキャンとサムネイル生成（バックグラウンドキュー処理: `scanDir`, `enqueueThumb`, `processQueue`, `generateThumbnail`）
- yt-dlp連携によるダウンロードジョブ管理

## public/app.js — フロントエンド（SPA、フレームワーク無し）
- ギャラリー/リスト表示、フォルダツリー、フィルタ（`renderGallery`, `renderFolderTree`, `applyFilters`）
- インスペクタ（タグ・評価・カラーパレット編集）（`openInspector`, `renderInspectorTags`, `extractPalette`）
- ダウンロードジョブのUI（`startDownload`, `pollJob`, `addJobCard`）
- コレクション管理、トースト通知、UI状態の保存/復元

**Why:** IPC越しの3プロセス構成のため、静的解析（code-review-graphのコミュニティ検出）では3ファイルがそれぞれ孤立したコミュニティとして検出される。実際の結合度は preload.js のIPCブリッジとHTTP fetch経由の `server.js` API呼び出しで保たれている。

**How to apply:** 機能追加時は「どの層の責務か」を意識して配置する。UIロジックは `public/app.js`、ファイルシステム/外部プロセス操作は `server.js`、OS統合（自動更新・ツールDL・ウィンドウ）は `electron-main.js`。
