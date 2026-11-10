# Supabase接続の手順（DRY_RUN維持）

アカウントの準備だけでは接続されません。新規のSupabaseプロジェクトにSQLを適用し、
GitHubのSecretsを設定してから手動で接続確認します。SNSの認証や投稿はこの作業に含みません。

## 1. プロジェクトとDBを準備

1. SupabaseでFreeプランのプロジェクトを作成し、起動を待ちます。意図しない有料プランへ変更しません。
2. プロジェクトの **SQL Editor → New query** を開きます。
3. リポジトリの [`supabase/migrations/001_store.sql`](../supabase/migrations/001_store.sql) を開き、
   **ファイルの内容全部**をSQL Editorへ貼り付けて実行します。
4. 成功を確認します。`kurashi_`で始まる9テーブルと`kurashi_store_v1`関数が作成されます。

このSQLは既存テーブルを削除しません。同じファイルの再実行は可能です。
ただし既存の別アプリの名前と衝突しない新規プロジェクトを推奨します。
データは非公開です。anon/authenticatedには読取・RPC実行を許可しません。
service_role相当のサーバー用キーをGitHub Actions内だけで利用します。

## 2. GitHub Secretsを設定

GitHubリポジトリの **Settings → Secrets and variables → Actions → Secrets → New repository secret** を開きます。

| Secret名 | 設定するもの |
|---|---|
| `SUPABASE_URL` | SupabaseのProject URL。`https://...supabase.co`の形式 |
| `SUPABASE_SECRET_KEY` | Supabaseのサーバー用Secret key（`sb_secret_...`） |
| `BACKUP_ENCRYPTION_KEY` | バックアップ用のランダム32バイトをBase64化した値 |

古い形式を使う場合は、`SUPABASE_SECRET_KEY`の代わりに`SUPABASE_SERVICE_ROLE_KEY`へservice_role JWTを設定できます。
anon、publishable key、DBパスワードでは動きません。
バックアップキーは、手元の信頼できる端末で`openssl rand -base64 32`などを使って生成してください。
復旧に必要なので、GitHubとは別の安全な保管先にも保存してください。
**キーをチャット・README・ソースコード・Pagesに貼らないでください。**

## 3. 接続だけ確認

1. リポジトリの **Actions** タブを開きます。
2. **Supabase connection and DRY_RUN** を選択します。
3. **Run workflow** でbranchは`main`、operationは`check`を選びます。
4. ジョブが成功し、出力に`connected: true`、`schemaVersion: 1`、`dryRun: true`があることを確認します。

`check`はhealth RPCのみで、商品取得、DBレコード作成、AI、SNS投稿、画像公開を行いません。
接続済みになっても本番投稿は有効になりません。

## 4. 日々のDRY_RUNにも永続DBを使う

接続確認に成功したら、GitHubの **Settings → Secrets and variables → Actions → Variables** に
`STORAGE_BACKEND`というRepository variableを追加し、値を`supabase`にします。

以降、8枠のスケジュールはSupabaseに投稿状態を記録します。
未設定時は従来のローカルSQLite方式で、Actions間の履歴は永続化されません。
キーがない・DB停止・権限不足のときに、Supabaseからローカルへ自動的に切り替えて処理を続けることはありません。

現段階のスケジュールには実商品の取得・割当をまだ接続していません。
`no_product`等でスキップされるのが正常で、設定だけで5商品の投稿が始まるわけではありません。
楽天の現行仕様確認、実商品の許諾2枚、SNS権限等の残件は別途必要です。

## 5. 集計・バックアップ

同じ手動workflowで`report`、`run`、`backup`を選べます。
`run`は投稿しないDRY_RUN状態の記録、`backup`はAES-256-GCM暗号化したファイルの作成/検証です。
artifactに保存するのは暗号文だけです。平文DBやエクスポートをアップロードしません。

`STORAGE_BACKEND=supabase`なら、毎月1日09:20 JSTに暗号化バックアップ・整合性チェック・ログ整理・レポートを実行します。
予算の管理月はこのジョブに依存せず、Asia/Tokyoの毎月1日00:00で切り替わります。
月次artifactは90日保持の設定ですが、リポジトリ/契約側の保持・容量条件が優先されます。
長期保管と復元鍵の保管は、管理者が別の安全な場所でも行ってください。

手元で復元する場合は、SQL適用済みの**空の別プロジェクト**のURL/Secretと同じ復元鍵を設定し、
`node --env-file=.env src/cli.js db-restore /private/state.encrypted.json --empty-target`を実行します。
レコードが1件でもある対象は拒否します。商品番号と削除済み番号のシーケンスも引き継ぎます。
unknown/sendingを復元しても自動再送しません。

## よくある停止理由

| エラー | 確認点 |
|---|---|
| `supabase_config_missing` | Project URL・サーバー用キーがSecretsに設定されているか |
| `supabase_server_key_required` | publishable/anonではなくサーバー用Secretか |
| `supabase_access_denied` | キーの失効・誤り・権限・プロジェクトが一致しているか |
| `supabase_unavailable` | SQL全体を適用したか、プロジェクトが停止していないか |
| `supabase_result_unknown` | 通信結果が不明。書込みは無条件に再試行しない |
| `backup_key_missing` | Base64化した32バイトの復元鍵が設定されているか |
| `backup_integrity_failed` | 鍵違い・ファイル破損。上書きせず元ファイルを確認 |

Freeプランの容量・休止・帯域・プラン変更は月次で確認してください。無料枠内の継続は保証しません。

## 仕様確認

2026-11-07に公式のRPCとAPI keys資料を確認。

* https://supabase.com/docs/reference/javascript/rpc
* https://supabase.com/docs/guides/api/api-keys

現在のプロジェクトへの接続は、上記の手順で別途確認する必要があります。
ローカル実PostgreSQLテストと、利用者プロジェクトの接続成功を同一視しません。

## 昼の雑談追加への更新

既存・新規プロジェクトとも、001の後に[002_noon_daily.sql](../supabase/migrations/002_noon_daily.sql)を適用してください。[詳細手順](DAILY_PLAN.md)。上限は商品5・雑談3の計8件です。
