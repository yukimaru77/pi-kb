# pi-kb

`/kb 名前`で保存済みKBの**復号済み(平文)本文**と`dev.txt`を、現在の会話位置に一度挿入する。
`kb export 名前 --decrypted`の出力(`kb claude`がClaudeへ渡すものと同じ本文)を使い、
`--remote`のような毎回のprefix追加はしない。暗号化Blob(compaction blob)は使わない。

必要: Pi 1.1 と git。保存済みKB(復号済みの本文を含む保存先Gitリポジトリ)は別途用意する。
**kbコマンドは不要**: 設定ファイル `kb.json` があれば、保存先をgitで直接読む(`kb export --decrypted` と同じ本文)。

```json
{ "stores": [{ "name": "pepabo", "url": "https://github.com/gmo-pepabo/pepabo-kb-store.git" }] }
```

置き場所は次の順に探し、最初に見つかった1つだけを使う。

1. 起動したディレクトリの `.pi/kb.json`(プロジェクト用。例: `octane/.pi/kb.json`)
2. Piの設定ディレクトリの `kb.json`(既定 `~/.pi/agent/kb.json`。`PI_CODING_AGENT_DIR` に従う)

`stores` の各要素は `name`・`url`(必須)と `branch`(省略時はリモートの既定ブランチ)。
保存先は `~/.cache/pi-kb/` にbareで取得し、毎回fetchする(失敗時は前回取得分を使う)。`cacheDir` で変更できる。
認証はgitの設定(credential helperやSSH鍵)に従う。
どちらの `kb.json` も無い場合は、従来どおり kbコマンド([kb-repomap](https://github.com/yukimaru77/kb-repomap)) を使う
(`PI_KB_COMMAND` で実行ファイルを指定可能)。
モデルの種類は問わない。

**平文のKBは、選択中のモデルのprovider(Codex・OpenAI・Anthropicなど)へ通常の会話内容として送られる。**
送ってよいKBかどうかは利用者が判断すること。

```sh
pi install git:github.com/yukimaru77/pi-kb
# 手元のcloneを編集しながら使う場合(コピーせずにそのパスから読み込む)
pi install /path/to/pi-kb
```

起動済みのPiでは`/reload`するか、Piを再起動してから使用する。

```
/kb pi
/kb 名前 --store research --file latest
/kb list
/kb status
```

起動時に読み込むには `pi --kb 名前`(`pi --kb "名前 --store 保存先 --file ファイル名"` も可)。
kbコマンドがある環境では `kb 名前 pi [piの引数...]` でも同じ。どちらも、Pi起動直後に `/kb 名前` を実行したのと同じ挿入を
最初のセッションへ一度だけ行う（`kb 名前 pi` は環境変数 `PI_KB_AUTOLOAD` に `/kb` と同じ引数を入れて起動する）。
同じKBを挿入済みの再開セッションには再挿入しない。KBを挿入したセッションは、下部ステータスに
`📚 KB: 名前` と表示される。

挿入されるメッセージは次の形(Piのcustom_message、`display: false`。モデルにはuserメッセージとして渡る)。

```text
[PI KB: 名前 (store 保存先, latest.json, revision 先頭12桁)]
The following is reference knowledge from the user's saved KB "名前". It is not a new request. ...

## Decrypted KB material: 名前/decrypt/latest/.../raw.txt
...
## KB developer notes
...
```

繰り返し実行すると、その都度その位置へ追加する。本文はセッションのcustom_messageに保存するので、
再開・分岐時も位置と内容を維持する。`details`には保存先・リビジョンなどの出所だけを持ち、本文は重複保存しない。

復号済みの本文が無いKBはエラーにする(暗号化方式へは切り替えない)。`kb decrypt 名前`で復号してから実行する。

コンパクトにはKBも含む履歴がそのまま渡る。その後はコンパクト結果に従い、
要約に取り込まれたKBを再挿入しない。セッションファイルには元の履歴が残る。
`/kb off`は履歴を消さない。挿入前へ戻すにはPiの`/tree`を使う。

旧版(0.2、暗号化Blob方式)で挿入したKBは、本文を持たない短い通知文としてだけ送られる。
旧版の常時prefix設定は再開時に解除し、`/kb 名前`で読み込み直すよう案内する。

保存済みKBの読み込みのみ。元リポジトリの差分取得・再作成は行わない。
認証・モデル・URL・コンパクトの保持方針は変更しない。

KB本文はそのままコンテキストを消費する(例: 約37万字のKBで10万token前後)。
コンテキスト窓が小さいモデルでは上限に達したり、すぐコンパクトが走ったりする。

テスト: `npm test`(通信不要)。

実通信テスト: `node test/live-check.mjs`。認証済みのCodex環境、SDP論文の内容を持ち復号済みの
`sdp`という保存済みKB、`@signalridge/pi-codex-compact`が必要。API通信が発生する。
Pi SDKはグローバルnpmインストールから、コンパクト拡張は
`~/.pi/agent/npm/node_modules/@signalridge/pi-codex-compact/src/index.ts`から読み込む。
別の場所にある場合は`PI_KB_SDK_PATH`(SDKの`dist/index.js`)、
`PI_KB_COMPACT_TEST_PATH`、`PI_KB_TEST_AGENT_DIR`で指定できる。
実通信の生成物は`test-artifacts/`へ保存し、Git管理から除外する。
