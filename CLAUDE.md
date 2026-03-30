# videoref — CLAUDE.md

動画リファレンス管理アプリ（Electron + Express）。
詳細なプロジェクトドキュメントは Obsidian vault の以下ファイルを参照：
- `D:\obisidian\nicebase_v01\sabiasagi\00_SCRAPBOX\text\📦 videoref プロジェクト引き継ぎ.md`
- `D:\obisidian\nicebase_v01\sabiasagi\00_SCRAPBOX\text\🔍 見つかった問題点（総合レビュー）.md`

---

## 重要な注意事項

### PowerShell で JS ファイルを直接編集すると日本語が文字化けする
必ず以下を使う:
```powershell
[System.IO.File]::WriteAllText("path", $content, [System.Text.UTF8Encoding]::new($false))
```

### dist への反映が必要
`D:\claude\eagle-app-exe\` で編集後、`dist\win-unpacked\resources\app\` にコピーしないとEXEに反映されない。

### リリース手順
package.json の version を上げてから:
```powershell
git add . && git commit -m "vX.X.X: 内容"
git tag vX.X.X
git push origin main && git push origin vX.X.X
```
タグとversionが一致しないとexeがReleaseにアップロードされない。

---

## ファイル構成

```
electron-main.js   # メインプロセス（ツール自動DL・自動更新・ウィンドウ）
preload.js         # IPC橋渡し
server.js          # Express API（127.0.0.1バインド済み）
public/
  index.html       # SPA
  app.js           # フロントエンド全ロジック
  style.css        # ダークテーマ
.github/workflows/
  release.yml      # タグpushで自動ビルド＆Release
```

## 起動

```powershell
cd D:\claude\eagle-app-exe
npx electron .
```

## 主要環境変数（server.jsが受け取る）

| 変数 | 内容 |
|------|------|
| EAGLE_PORT | サーバーポート |
| EAGLE_LIBRARY | ライブラリパス |
| EAGLE_DATA | データディレクトリ |
| VIDEOREF_FFMPEG | ffmpegバイナリパス |
| VIDEOREF_FFPROBE | ffprobeバイナリパス |
| VIDEOREF_YTDLP | yt-dlpバイナリパス |

## 残タスク

Low優先度（🔍ファイル参照）:
- #16: autoUpdater リトライ強化
- #17: ソフトデリート（ゴミ箱）
- #18: EyeDropper フォールバック

機能追加候補:
- F1: 起動トークン認証
- F2: chokidar ファイル監視
- F3: バッチ操作
- F4: SQLite DB化
