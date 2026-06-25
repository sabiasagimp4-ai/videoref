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
