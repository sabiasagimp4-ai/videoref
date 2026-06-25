# code-review-graph を使う

コード探索・影響調査・レビューでは **Grep/Glob/Read より先に** code-review-graph MCP を使う。グラフの方が速く・安く・構造（呼び出し元/依存/テスト）が分かる。

## 手順
1. グラフが空なら最初に `build_or_update_graph_tool`（初回は `full_rebuild=true`）。
2. 探索: `semantic_search_nodes_tool` / `query_graph_tool`（`callers_of` `callees_of` `imports_of` `tests_for` `file_summary`）。
3. 影響範囲: `get_impact_radius_tool` / `get_affected_flows_tool`。
4. レビュー: `detect_changes_tool` → `get_review_context_tool`。
5. 全体像: `get_architecture_overview_tool` / `list_communities_tool`。

グラフで足りない時だけ Grep/Glob/Read にフォールバックする。

**Why:** トークン節約とリレーション把握。ファイル走査では呼び出し元・依存・テストの構造が見えない。

**How to apply:** 「まずグラフ、足りなければファイル」。変更後はグラフが追従しているか必要に応じて `build_or_update_graph_tool` で更新。
