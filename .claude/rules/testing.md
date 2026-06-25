# テスト・検証

## 実ブラウザでのバグ検出（重要）
UI/フロントの変更や「バグが多い」系の調査では、**本番と同じ Electron + Chromium** で
実際に動かして検証する。静的レビューだけでは初期化時のスコープエラー等を見逃す。

常設ハーネス: [`tools/ui-test-harness.js`](../../tools/ui-test-harness.js)

```powershell
# PATH に ffmpeg が無ければ先に指定
$env:VIDEOREF_FFMPEG = "...\ffmpeg.exe"
npx electron tools/ui-test-harness.js           # コンソール/例外検査＋スモーク操作
npx electron tools/ui-test-harness.js --shots   # 画面キャプチャも temp に保存
```

末尾の `RESULT` の `issues[]` が空ならコンソールエラー無し。`INTERACTIONS` で
プレイヤー（再生ボタンのみ/コマ送り/速度/回転/シーク/閉）とインスペクタの画像
プレビューが想定どおりか確認できる。`--shots` 時は `SHOTS_DIR` のパスに PNG を保存。

**残る CSP 警告は Electron 開発時のみ**（パッケージ後は出ない）→ バグではない。

## 隔離の鉄則（破らない）
- 実データ・実 AppData・実ライブラリに**絶対に触れない**。
- 検証は必ず使い捨て temp ディレクトリ＋非デフォルトポート＋明示的な env
  (`EAGLE_PORT` / `EAGLE_LIBRARY` / `EAGLE_DATA` / `VIDEOREF_FFMPEG`) で行う。
  ハーネスは `os.tmpdir()` 配下に使い捨てライブラリを作り、終了時に削除する。

**Why:** 過去に initUI 内へ閉じ込められた関数（showToast 等）がグローバル呼び出しで
ReferenceError になり、起動時のコレクション読み込み・カラーパレット・トーストが静かに
壊れていた。これは実ブラウザ実行で初めて検出できた。[[initui-scope-trap]] 参照。

**How to apply:** フロント変更をコミット/リリースする前に `npx electron tools/ui-test-harness.js`
を一度通し、`issues[]` が空であること・`INTERACTIONS` が期待どおりであることを確認する。
