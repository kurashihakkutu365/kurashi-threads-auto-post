# 暮らしの発掘室 Ver.1.7 — DRY_RUN開発版

Threads・Instagram向けの低コスト自動運用基盤です。**本番運用は未完成・無効**です。
外部APIを使わず、安全条件と1日14件の処理をモックで検証できます。Xには対応しません。

開始時のリポジトリには見出しだけのREADMEしかなく、Ver.1.6のコードは存在しませんでした。
[初期調査](docs/INITIAL_AUDIT.md)、[費用の確認](docs/COSTS.md)、[本番移行の残件](docs/RELEASE_GATES.md)を参照してください。

**Supabaseを準備済みの方:** [SQL適用・GitHub Secrets・接続確認の手順](docs/SUPABASE_SETUP.md)から進めてください。
アカウントを作っただけではまだ接続されません。接続成功後もDRY_RUNを維持します。

**Threadsトークンを保存済みの方:** [投稿しない接続確認の手順](docs/THREADS_SETUP.md)で、トークンの対象アカウントを確認できます。

## 動かす

Node.js 24 LTSを使用します。依存関係のバージョンはlockfileで固定しています。

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

デモは架空の商品・モック画像URL・仮想時刻を使い、Threads 7件・Instagram 7件のDRY_RUNを処理します。
楽天・Meta・AIへの通信、画像ダウンロード、公開アップロード、SNSへの実投稿はしません。
`var/demo-report.json`、`var/demo.sqlite`、`var/site-preview/`、`var/private-images/`を生成します。
デモのscore・レビュー・URL・画像許諾はテスト専用で、実商品の評価や許可を意味しません。
このデモサイトを本番の商品一覧として公開しないでください。

```sh
npm run report       # state.sqliteの月次レポート（demo.sqliteとは別）
npm run backup       # state.sqliteのローカルバックアップ
npm run restore-check
npm run export       # 非公開JSONエクスポート
npm run cleanup      # 既定90日でログ・完了イベント本文を整理
node src/cli.js stop # DBに全停止を保存
node src/cli.js sns-stop instagram
```

秘密情報は環境設定/Actions Secretsで管理してください。`.env.example`はキー名の見本です。
`.env`を使う場合は`node --env-file=.env src/cli.js report`等で明示します。リポジトリには保存しません。

## 実装した範囲

* JSTの7枠、媒体別最大7件/日、商品5件・日常2件の制限、遅延枠のスキップ。
* SQLiteとSupabaseの一意制約・トランザクション、30日同一商品抑止、送信不明時の保留と照合。
* 月次予算予約、実使用tokens・推定額・実請求の区別、段階制限、カテゴリ/日次上限。
* 商品候補の日次バッチ・キャッシュ、8ジャンル、100点評価、画像AI評価キャッシュ。
* [画像許諾登録](docs/RIGHTS.md)、用途別・期限・ハッシュ検証、異なる2枚必須。
* Responses APIアダプターとJSON Schema、同一商品の両媒体用共用生成、事実/PR/類似文の検証。
* Threads/Instagramの公式カルーセル作成・公開プロトコル。実通信はCLIから接続しません。
* 静的商品一覧、ジャンル検索、永久商品番号、PR/プライバシー/問い合わせ、公開HTMLの照合。
* 日常テンプレートとAIの2件まとめ生成、オリジナルSVG→1080×1080 JPEG生成。
* Webhook署名検証・重複排除・返信キュー・停止・除外・件数/連投制限。
* バックアップ、整合性/チェックサム復元試験、エクスポート、月次レポート、依存更新設定。
* Supabase接続確認、サーバー側の予算予約・枠取得、暗号化バックアップ、空DBへの復元。
* Threadsの読み取り専用接続確認。期待アカウントを照合し、トークンをログやURLへ出しません。

既定の文章生成は無料の事実テンプレート、評価はモックです。有料AIは設定・料金・権限・品質評価後に注入する設計です。
日常の無料テンプレートは少数の見本で、30日履歴で使い切ったらスキップします。
本番で毎日2件を維持するにはAIバッチ結果の永続割当と十分な候補を接続する必要があります。

## 安全設定

`config/default.json`で停止・上限・モデル/料金・APIバージョンを設定します。
`DRY_RUN=true`、設定ファイルの`dryRun=true`のどちらかが有効ならDRY_RUNです。
さらに現行CLIは本番ランナーを提供せず、`dryRun=false`でも実行を拒否します。

設定やDBが故障したら投稿しません。画像1枚や画像なしの商品投稿へ切り替えません。
通信切断後の`sending`/`unknown`は無条件に再送しません。
権利確認・商品情報の正確性・予算・規約条件を満たせなければ枠をスキップします。
文章の意味的な真偽を正規表現だけで保証できないため、商品本文は承認済み事実の完全一致を必須にしています。

## GitHub Actions・GitHub Pages

`schedule.yml`はJST 07:00 / 08:10 / 10:30 / 12:20 / 16:00 / 17:40 / 19:00に対応するUTC設定です。
実行は遅延することがあります。20分を超えた枠はスキップし、古い枠をまとめて公開しません。
現在はDRY_RUN専用で、実商品がない枠は安全にスキップします。
**Actionsの一時ディスクは永続DBではありません。** Supabase用のSQL/RPCと接続確認workflowを追加しました。
SQL適用・Secrets設定・接続確認の成功後、Repository variable `STORAGE_BACKEND=supabase`で永続化します。
未設定時は従来のローカルSQLiteです。Supabase障害時にSQLiteへ自動フォールバックしません。
返信に5分間隔のActions常時起動は使用しません。Webhook受信基盤のデプロイは未実施です。

商品一覧は`npm run site`で`state.sqlite`から生成します。
本番Pages公開は、掲載先登録・サイト画像許諾・お問い合わせ先の準備後に行います。
現在は公開Workflowを設けていないため、意図せずサイトや許諾資料を公開しません。

## ブラウザ検証

```sh
npm run demo
npx playwright install chromium
npm run test:browser
```

既存Chromiumを使う場合は`CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`。
390px幅、横スクロール、ジャンル検索、JavaScriptエラーを確認し、`var/mobile-preview.png`に保存します。
ブラウザテストでも外部リクエストを遮断します。日本語フォントはNoto Sans CJK JP等を利用し、配布条件を確認してください。

## 構成と今後

`src/`に機能別モジュール、`test/`に外部APIなしのテスト、`docs/`に調査・費用・移行条件を保存しています。
本番の楽天連携、利用者Supabaseへの接続確認、Webhook/実返信API、トークン更新、通知、画像配信、Pages公開は残件です。
月1,000円以内・5年間の無保守運用・正確な数分後の返信は保証しません。
月1回の管理者確認と、無料枠・料金・公式仕様変更への継続的な対応が必要です。
