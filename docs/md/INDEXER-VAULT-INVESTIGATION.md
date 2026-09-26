# Indexer Vault 読み取り停止の調査

現在の状態: 承認後の修正と検証を実施済み。第1〜4節は調査時点、第5節が修正後の記録。

調査日: 2026-09-26。対象: Ponder 0.17.12 / viem 2.49.0。
ブランチ: `feat/frontend-protocol-integration`。

結論: 初回起動の開始ブロック不整合と、同期後の空応答キャッシュ問題は別件。後者は依存ライブラリの保存・再試行経路で再現した。調査のみを実施し、backend / contract / SDK / deployment / node_modules / 元DBには変更を加えていない。追加したのは本記録と通信不要の診断スクリプト。

## 1. 起動直後: Hook が存在する前から Vault を読む

`deployments/unichain-sepolia.json` の deployBlock は `63569270`。`indexer/src/deployment.ts:53` は SNAPSHOT_START_BLOCK がない場合、この値を snapshot 開始にも用いる。

公開RPCの eth_getCode をブロック指定して確認した結果:

| ブロック | 現行 Hook のコード |
|---|---|
| 63569270 | 0x |
| 63569308 | 0x |
| 63569309 | 24,432 bytes |
| 63569470 | 24,432 bytes |

63569270 の navPlus / navMinus / totalShares / vaultIdle はいずれも HTTP 200、result=0x。したがって、初回の VaultSnapshot が失敗するのは再現可能。イベント同期を早く始めることと、コントラクト状態の snapshot を読める開始時点は分ける必要がある。

既存の環境変数 `SNAPSHOT_START_BLOCK=63569470` でこの初期範囲を避けて backfill が進んだことは Phase 5 で検証済み。ただし後述の問題は別途残る。63569309 は Hook の初出ブロックであり、他コントラクトや oracle の初期化まで含めた最適開始値とは断定していない。

## 2. 同期後: 空応答がキャッシュに入り、再取得されない

21:59 に `/ready` が200となり、実履歴のブラウザ確認に成功した。その後 VaultSnapshot:block `63575170` でエラーが繰り返され、22:01:06 に停止した。

停止後の PGlite を `/private/tmp/phinary-ponder-investigation-db` にコピーして調査した。元DBは未変更。Ponder 自身と同じ request の正規化と MD5 計算を使い、`ponder_sync.rpc_request_results` と照合した。

| 関数 | 同ブロックの保存値 | 同ブロックを直接再取得した値 |
|---|---|---|
| navPlus | 文字列 `null` | 93355145 |
| navMinus | 文字列 `null` | 93355145 |
| totalShares | 正常なABI応答 | 93355145000000 |
| vaultIdle | 文字列 `null` | 73355145 |

空応答の request_hash:

- navPlus: `9e1c26b86caddab890e03a838b40ac6e`
- navMinus: `bf55efd79a783ebfbaaa0cd31d177c67`
- vaultIdle: `c52d3a78e7746c5e46f034bd9fab2e7e`

### 保存されてしまう経路

`indexer/node_modules/ponder/src/indexing/client.ts` のローカル実装を確認:

1. 87行: キャッシュ除外値は生の `"0x"` と `null`。
2. 766行付近: prefetch の応答を `JSON.stringify(result)` で文字列化し、Promise をメモリに保存。
3. 1076行: 文字列化済みの値を、生の除外値と比較する。文字列 `"null"` と null は異なるため除外されない。0xも引用符を含む文字列になるため同様。
4. 1079行付近: この値が永続DBに保存される。
5. 1062〜1120行: 再試行でもメモリまたはDBの値があればそれを返す。RPCに再取得しない。
6. `getRetryAction` は初回＋9回再試行するが、このキャッシュ問題を解消しない。

同様の型比較は multicall の先読み分岐にもある（893行）。今回の Vault ハンドラーは4つの readContract を Promise.all で実行しており、上記の通常 readContract 経路が対象。

上流の参考実装: [Ponder client.ts](https://github.com/ponder-sh/ponder/blob/main/packages/core/src/indexing/client.ts)。上流 main は変わり得るため、この調査の根拠はインストール済み 0.17.12 と実DB・再現結果。

### 決定的な最小再現

```sh
node web/scripts/diagnose-indexer-cache.mjs
```

インストール済み Ponder の cachedTransport をそのまま使う。RPCとDBはメモリ上の代用品で、空の先読み応答の後は正常値を返せる状態にする。公開RPCや元DBへの通信・書き込みはない。

null と 0x のそれぞれで:

- 10回連続の readContract が失敗。
- その間の RPC 呼び出しは0回。
- メモリキャッシュをクリアしても、保存済み空値から失敗が再現。
- 代用DBの空値も除去すると RPC を1回呼び、93355145を取得。

これは修正後の回帰テストではなく、未修正依存の不具合を確認する診断。実依存を修正した場合には期待結果も更新する必要がある。

## 3. 確定事項と未確定事項

確定:

- 初回 snapshot の開始時点には現行Hookが存在しない。
- 停止ブロックの3種類の Vault 読み取りで、空値がDBに残っている。
- 依存の先読み処理は空値を保存し、再試行を実際のRPC再取得に繋げない。
- この処理だけで今回の「直接読み取りは成功、indexerは失敗」を再現できる。

未確定:

- 初回の null がRPC側で返った具体的理由。当時の生HTTP応答を保存していないため、負荷・ノード間差・一時障害等のどれかは断定できない。
- 修正後の長時間運転。今回は修正を適用しておらず未検証。

`PGlite is closed` は停止後に続いた二次的なエラーで、最初の Vault 失敗と区別する。

## 4. 次の修正で必要なこと（未実施）

1. snapshot 開始を、必要なコントラクトが利用可能なブロック以降に設定する。既存環境変数で対応可能。取引イベント開始を遅らせて欠落させない。
2. Ponder の先読みキャッシュで、空値を decode 後に判定し、メモリにも永続DBにも保存しない。空値を持つPromiseを再試行で再利用せず、実際のRPC再取得に進める。単に保存時の比較を直すだけではメモリ再利用が残る。
3. 既に永続化した空値は、バックアップ後に対象を絞って無効化するか、新規DBで再同期する。コード修正だけでは既存DBの空値は消えない。
4. 空応答→正常応答の回復、再起動後、readContract と multicall 両経路を回帰テストし、既存 indexer の同期・継続稼働を検証する。

RPC変更のみ、再試行回数の増加のみ、あるいは先頭 snapshot を飛ばすだけでは、既に保存された空値の問題を解決しない。修正版リリースの有無は採用時に確認する。現時点で依存更新、DB削除、バックエンド修正はしていない。


## 5. 承認後の修正（2026-09-26）

上記は調査時点の記録。チーム承認後にユーザーから修正の指示を受け、以下を適用した。

- `indexer/src/deployment.ts`: 現行 Sepolia Hook に対する snapshot の安全な下限を63569470に設定。ローカルや別Hookの設定は従来どおりdeployBlockを使用。イベント同期の開始は63569270を維持。整数でない値や安全な下限より前のoverrideを拒否。
- `indexer/patches/ponder+0.17.12.patch`: 空の先読み応答を拒否し、メモリの空値・失敗を削除、DBの空値を無視してRPCを再取得する。readContract / multicall 両方に適用。正常なキャッシュは維持。
- 公開最新版も0.17.12だったため、バージョン固定の依存パッチを採用。`npm ci` のpostinstallで自動適用し、適用失敗をエラーにする。
- 既存の空キャッシュを無視して復旧できるため、元DBの削除・直接修正は行っていない。新たな変更はindexerとテスト・記録に限定。コントラクト、SDKソース、deployments、共有DBは変更なし。
- `web/scripts/diagnose-indexer-cache.mjs` は修正後の回帰テストを起動する形に更新。上記の「10回失敗」は修正前の検証記録。

### 修正の検証

- 修正前: 12 recovery cases失敗、valid cache caseのみ成功。
- 修正後: 15 cache cases成功。null/0x、Promise/メモリ/DB、readContract/multicallに加え、実際のPonder prefetchからの復帰と通常RPCの空応答後の再試行を確認。
- Node 24.21.0でindexer全テスト: 42 passed / 2 skipped。スキップは既存のローカルfork結合テスト（INDEXER_URL未設定）とlocal deployment依存のテスト。型チェック成功。SDKの既存依存はnpm ciで復元、SDKソース・lockfileの変更なし。
- 実障害DBのコピーで63575170のVault読み取りを実行。空値の3件のみRPCを再取得し、navPlus=93355145、navMinus=93355145、totalShares=93355145000000、vaultIdle=73355145。正常キャッシュは再利用。元DBは未変更。
- 新規一時ディレクトリでのnpm ciによるパッチ適用も検証。ライブ確認は元DBと分離した新規PGlite、既存バックエンドソースのコピー、公開チェーンreadのみで実施。snapshot開始を63576730に絞ったsmoke testで、全イベントはdeployBlockから同期。

- 新規npm ci: postinstallでponder@0.17.12パッチ適用成功。元インストールと修正済みESMのバイト一致を確認し、新規環境でも15 cache cases成功。
- 実チェーン: 22:31:12にbackfill完了・`/ready`=200。63576984からライブ更新へ移行し、最終63577189まで追従（ライブ移行後2分以上）、GraphQLで直近のVault snapshot 63577090 / 63577120 / 63577150を取得。RPCの一時的なblock取得警告からは回復し、Vault停止エラーなし。これは短時間のsmoke testで、長時間運転の保証とは区別する。
- ローカル旧DBは保存したまま。検証用の新規DBと公開readだけを使い、取引送信は行っていない。共有indexerプロセスは停止・変更していない。
