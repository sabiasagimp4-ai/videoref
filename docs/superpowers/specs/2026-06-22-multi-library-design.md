# 複数ライブラリ対応 + データ基盤の安定化 設計

## 背景・目的

videoref を Eagle に近づけるための4機能（複数ライブラリ切替・スマートフォルダ・ドラッグ&ドロップ取り込み・類似画像検出）のうち、最初の柱となる「複数ライブラリ切替」を実装する。

現状の課題: `metadata.json` / `trash.json` / `thumbs/` / `collections` はすべて `AppData/.../data/` 配下にライブラリ横断のグローバルな1セットとして保存されている。複数ライブラリに対応すると、別ライブラリの同一相対パスのファイルでタグやコレクションが衝突する可能性がある。この基盤問題を解消することを本サブプロジェクトのスコープに含める。

## スコープ

含む:
- ライブラリごとのデータ分離（`.videoref/` フォルダ方式）
- 既存データの自動移行
- ライブラリ一覧管理API
- サイドバーのライブラリスイッチャーUI
- ネイティブフォルダ選択ダイアログ

含まない（別サブプロジェクトで対応）:
- スマートフォルダ（保存済み検索）
- ドラッグ&ドロップ取り込み
- 類似画像/重複検出

## データモデル

### ライブラリフォルダ内（Eagle方式、新規）

```
<libraryPath>/
  .videoref/
    metadata.json    # タグ・ノート・色・評価・URL（現行形式そのまま）
    trash.json        # ゴミ箱台帳
    trash/             # ゴミ箱移動済みファイル本体
    thumbs/            # サムネイルキャッシュ（<id>.jpg）
    collections.json  # このライブラリのコレクション一覧
```

各ライブラリが自己完結する。USBドライブ等で別PCに持ち運んでも、タグやコレクションがそのまま使える。

### アプリ全体設定（`AppData/.../data/settings.json`、グローバル）

```json
{
  "libraries": [
    { "id": "lib_xxxx", "name": "メインリファレンス", "path": "D:\\リファレンス保存\\eaglemodoki" }
  ],
  "activeLibraryId": "lib_xxxx"
}
```

旧形式の `libraryPath` 単一フィールドは廃止。`id` は `Date.now().toString(36) + ランダム文字列`（既存の collection id 生成と同じ方式）。

### 既存データの移行

起動時、`settings.json` に旧形式の `libraryPath`（文字列）が残っていて `libraries` 配列が存在しない場合に1回だけ実行:

1. `AppData/.../data/metadata.json` → `<libraryPath>/.videoref/metadata.json` に移動
2. `AppData/.../data/trash.json` → `<libraryPath>/.videoref/trash.json` に移動
3. `AppData/.../data/trash/` → `<libraryPath>/.videoref/trash/` に移動（ディレクトリごと）
4. `AppData/.../data/thumbs/` → `<libraryPath>/.videoref/thumbs/` に移動
5. `settings.collections`（旧グローバル） → `<libraryPath>/.videoref/collections.json` に移動
6. `libraries: [{id: 新規生成, name: "Library", path: libraryPath}]`、`activeLibraryId` をそのidに設定し `libraryPath` フィールドは削除
7. 移行後は旧パスにファイルが残らないため、次回起動時はこの分岐に入らない（再実行されない）

移行は `fs.renameSync`（同一ドライブなら高速・原子的）。失敗時（別ドライブをまたぐ等で `EXDEV` が出るケース）はコピー&削除にフォールバックする。

## API変更

### 新規

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/libraries` | `{ libraries: [{id,name,path}], activeLibraryId }` を返す |
| POST | `/api/libraries` | body `{name, path}`。path の存在確認 → `.videoref/` 配下を作成 → リストに追加 → そのライブラリへ自動切替 |
| PUT | `/api/libraries/:id` | body `{name}`。名前変更のみ（pathは変更不可、変えたい場合は削除して追加） |
| DELETE | `/api/libraries/:id` | リストから削除（ファイルは削除しない）。リストが1件のみの場合は400を返し拒否 |
| POST | `/api/libraries/:id/activate` | アクティブライブラリを切替 |

### 廃止

- `PUT /api/settings`（旧ライブラリパス変更用）は削除し、上記 `/api/libraries` 系に一本化する。
- `GET /api/settings` は現在のアクティブライブラリのパスと thumbDir を返す表示用エンドポイントとして残す。

### 内部実装変更（server.js）

- `DATA_PATH` `THUMB_DIR` `TRASH_DIR` `TRASH_PATH` を起動時固定の `const` から、現在の `LIBRARY_PATH` を見て都度パスを組み立てる関数（`metaPath()` `thumbDir()` `trashDir()` `trashJsonPath()` `collectionsPath()`）に変更する。
- `switchLibrary(id)` 関数を新設:
  1. `id` が `settings.libraries` に存在するか検証（なければ404相当のエラーを返す）
  2. `LIBRARY_PATH` を更新
  3. `.videoref/` 配下の各ディレクトリを `mkdirSync({recursive:true})` で確保
  4. `thumbCache` を新ライブラリの `thumbs/` から再読込
  5. `generating` Map と `thumbQueue` をクリア（古いライブラリ向けの生成タスクは無視してよい。実行中の ffmpeg プロセスは自然終了に任せ、結果は使わない）
  6. `settings.activeLibraryId` を更新して `saveSettings()`
- ダウンロードジョブ（`downloadJobs`）はジョブ生成時点の `LIBRARY_PATH` をクロージャで保持しているため、ライブラリ切替中でも安全に完了する。

## フロントエンドUI変更

- サイドバー最上部に「ライブラリ名 ▾」ボタンを新設（Eagle同等の位置・役割）。
  - クリックでドロップダウン表示。アクティブなライブラリにチェックマーク。
  - 各行クリックで `POST /api/libraries/:id/activate` → `loadFiles()` 再読込 → トースト表示。
  - 末尾に「+ ライブラリを追加」→ 名前入力 + フォルダ選択ボタン（ネイティブダイアログ）→ `POST /api/libraries`。
  - 各行（アクティブ以外）に削除ボタン → confirm → `DELETE /api/libraries/:id`。
- `preload.js` に `electronAPI.pickFolder()` を追加。`electron-main.js` 側に `ipcMain.handle('pick-folder', ...)` を追加し `dialog.showOpenDialog({properties:['openDirectory']})` を実行して選択結果のパスを返す。
- 設定モーダルの「ライブラリパス変更」テキスト入力欄は削除。現在のライブラリ名・パス・サムネイルキャッシュ先の表示のみに変更する。

## エラーハンドリング

- `POST /api/libraries`: path が存在しない/ディレクトリでない → 400。同一path が既に登録済み → 400（重複登録を防ぐ）。
- `DELETE /api/libraries/:id`: 残り1件の削除 → 400。アクティブなライブラリを削除する場合は、削除前に残りのライブラリの先頭へ自動切替してから削除を実行する。
- 移行処理（リネーム）が失敗した場合: コピー&削除にフォールバックし、それも失敗したらエラーログを出し、旧パスのデータはそのまま残す（データロストを避ける。次回起動時に再試行される）。

## テスト方針

自動テストは未整備のプロジェクトのため、手動確認で進める:
1. 既存ライブラリ1件の状態でアプリを起動 → 自動移行が走り、`<libraryPath>/.videoref/` にデータが移動していること、タグ・コレクション・ゴミ箱が引き続き表示されることを確認
2. 「+ ライブラリを追加」で別フォルダを追加 → 切替 → タグ付け→ 元のライブラリに戻して、タグが混在していないことを確認
3. ライブラリ削除（非アクティブなもの）→ ファイルが消えていないことを確認
4. ライブラリが1件のときに削除を試みて拒否されることを確認
