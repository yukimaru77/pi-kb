# pi-kb

`/kb 名前`で保存済みKBのBlob列と`dev.txt`を現在の会話位置に一度挿入する。
`kb NAME codex`の保存済みitemsを使い、`--remote`のような毎回のprefix追加はしない。

必要: Pi 1.1、`kb export`対応のkbコマンド、Codexモデル。
kbコマンドと保存済みKBは別途用意する。このリポジトリには含まれない。
kbの実行ファイルは`PI_KB_COMMAND`で指定可能。

```sh
pi install git:github.com/yukimaru77/pi-kb
```

起動済みのPiでは`/reload`するか、Piを再起動してから使用する。

```
/kb pi
/kb 名前 --store research --file latest
/kb list
/kb status
```

繰り返し実行すると、その都度その位置へ追加する。読み込んだ版をセッションの
custom_messageに保存するので、再開・分岐時も位置と内容を維持する。
Blobは文章化せずCodexへ渡し、dev.txtはdeveloper項目のまま保持する。

コンパクトにはKBも含む履歴を渡す。その後はコンパクト結果に従い、
消えたKBを元のsnapshotから再挿入しない。セッションファイルには元の履歴が残る。
旧版の常時prefix設定は再開時に一度だけ現在位置への挿入へ移行する。
`/kb off`は履歴を消さない。挿入前へ戻すにはPiの`/tree`を使う。

保存済みsnapshotの読み込みのみ。元リポジトリの差分取得・再作成は行わない。
暗号化KBにはCodexが必要。圧縮は導入済み`@signalridge/pi-codex-compact`と連携する。
会話では`before_provider_request`で履歴のアンカーを展開する。
compactはproviderを直接呼ぶため、Pi 1.1の`ctx.modelRegistry.runtime.getProvider`を
セッション中だけラップし、圧縮用inputにも同じ展開を行う。終了時に復元する。
認証・モデル・URL・コンパクトの保持方針は変更しない。

BlobのサイズはPiの送信前トークン見積もりに含まれないため、巨大KBはサーバー側の
コンテキスト上限に達することがある。

テスト: `npm test`（通信不要）。

実通信テスト: `node test/live-check.mjs`。認証済みのCodex環境、SDP論文の内容を持つ
`sdp`という保存済みKB、`@signalridge/pi-codex-compact`が必要。API通信が発生する。
Pi SDKはグローバルnpmインストールから、コンパクト拡張は
`~/.pi/agent/npm/node_modules/@signalridge/pi-codex-compact/src/index.ts`から読み込む。
別の場所にある場合は`PI_KB_SDK_PATH`（SDKの`dist/index.js`）、
`PI_KB_COMPACT_TEST_PATH`、`PI_KB_TEST_AGENT_DIR`で指定できる。
実通信の生成物は`test-artifacts/`へ保存し、Git管理から除外する。
