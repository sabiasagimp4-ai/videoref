# videoref — CLAUDE.md

動画リファレンス管理アプリ（Electron + Express）。リポジトリ: `github.com/sabiasagimp4-ai/videoref`

詳細なプロジェクトドキュメントは Obsidian vault の以下ファイルを参照：
- `D:\obisidian\nicebase_v01\sabiasagi\00_SCRAPBOX\text\📦 videoref プロジェクト引き継ぎ.md`
- `D:\obisidian\nicebase_v01\sabiasagi\00_SCRAPBOX\text\🔍 見つかった問題点（総合レビュー）.md`

開発ディレクトリ: `D:\自作拡張機能\videoref_dev`

詳細な運用ルールは `.claude/rules/` を参照：
- [`.claude/rules/encoding.md`](.claude/rules/encoding.md) — 日本語ファイル編集時の文字化け対策
- [`.claude/rules/architecture.md`](.claude/rules/architecture.md) — 3層構成の責務
- [`.claude/rules/release.md`](.claude/rules/release.md) — ビルド・リリース手順
- [`.claude/rules/code-review-graph.md`](.claude/rules/code-review-graph.md) — グラフ優先のコード探索
- [`.claude/rules/testing.md`](.claude/rules/testing.md) — 実ブラウザ検証ハーネスと隔離の鉄則

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
cd D:\自作拡張機能\videoref_dev
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

## 現在の状態（2026-06-25 時点・v1.4.2）

実装済み: ギャラリー/リスト・フォルダツリー・タグ/評価/カラー・インスペクタ・
yt-dlp DL・コレクション・スマートフォルダ・D&D取込・完全一致重複検出・知覚ハッシュ
類似検出・ウォッチフォルダ(chokidar)・マルチライブラリ・ゴミ箱・グローバル検索・
クリップボード貼付け取込・テーマ/UIズーム/グレースケール・クイックルック。
UIは日本語で統一済み。

### 動画モーダルの設計方針（重要・崩さない）
表示UIは **再生ボタン＋シークバーのみ**。速度/コマ送り/回転/全画面などは
Eagle 準拠キーボードショートカット（Space, `[ ]`, Shift+`[ ]`, Ctrl+←→, Shift+`,.`,
Shift+R, F）。**`<video>` に `controls` を戻さない**こと。キー判定は配列非依存の `e.code`。
キーボードハンドラは `app.js` の keydown 内「動画モーダル: Eagle準拠ショートカット」ブロック。

### 次の機能候補（ロードマップ）
- C4: 手動ドラッグ並び替え（順序をセッション間で保持）
- C2: タググループ/階層
- E2/E3: メタデータ CSV 書き出し／メタ駆動の一括リネーム
- 保留（要確認・範囲大）: A7/B3 URLショートカット項目（新しい非メディア型の導入）
- 旧Low: autoUpdater リトライ強化 / EyeDropper フォールバック / SQLite DB化

計画書: [`docs/superpowers/specs/2026-06-25-feature-gap-plan.md`](docs/superpowers/specs/2026-06-25-feature-gap-plan.md)

### 既知の構造的注意点
`app.js` の `initUI()` が多数の関数を内包しており、グローバル関数から呼ぶと
ReferenceError になる罠がある（4関数は `window.X = X` で橋渡し済み）。新たに
グローバルから initUI 内の関数を呼ぶ場合は同様の橋渡しが必要。詳細は testing.md /
メモリ参照。

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
