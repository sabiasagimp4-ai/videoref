# 文字エンコーディング

PowerShell で日本語を含む JS/JSON ファイルを直接編集すると文字化けする。

**Why:** PowerShellの既定エンコーディング(UTF-16LE or Shift-JIS系)で書き込まれ、UTF-8前提のソースが壊れる。

**How to apply:** PowerShellでこのリポジトリ内のファイルを書き込む際は、必ず以下のように明示的にBOMなしUTF-8を指定する。

```powershell
[System.IO.File]::WriteAllText("path", $content, [System.Text.UTF8Encoding]::new($false))
```

可能な場合は Edit/Write ツール（PowerShell経由ではない）を優先する。
