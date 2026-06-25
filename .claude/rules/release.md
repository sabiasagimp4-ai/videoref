# ビルド・リリース手順

## ローカルでの動作確認（再ビルド不要な軽い変更）
ビルド済みexe（`dist\win-unpacked\resources\app\` 配下）に変更を反映させたい場合、ソース編集後に該当ファイルを `dist\win-unpacked\resources\app\` へコピーする。`npm run build` を毎回実行しなくても素早く確認できる。

**Why:** `asar: false` のため `resources\app\` は展開済みの生ファイル構成。electron-builderのフルビルドより高速にイテレーションできる。

## 正式リリース
package.json の `version` を上げてから:

```powershell
git add . && git commit -m "vX.X.X: 内容"
git tag vX.X.X
git push origin main && git push origin vX.X.X
```

**Why:** `.github/workflows/release.yml` がタグpushをトリガーに `electron-builder --publish always` を実行し、GitHub Releasesにexeをアップロードする（`package.json` の `build.publish` 設定）。

**How to apply:** タグとpackage.jsonの`version`が一致していないと、ビルドされたexeがReleaseページに正しく紐づかない。コミット→タグ→pushの順序を守ること。
