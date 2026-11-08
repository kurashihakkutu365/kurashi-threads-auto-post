# Instagram Unified Loginの接続確認

確認日: 2026-11-09（JST）。投稿・返信は行わず、DRY_RUNのままアカウントの一致だけを確認します。

## Metaでの準備

1. Instagramをプロアカウントにし、MetaアプリにInstagram APIを追加します。
2. ビジネスポートフォリオを作成/選択してアプリをリンクします。
3. 「API setup with Unified login」で設定を作成します。
4. 自分のInstagramアカウントをInstagramテスターとして招待し、Instagramの「アプリとウェブサイト」→「テスターへのご招待」で承認します。
5. Meta開発者画面の「アクセストークンを生成する」で対象アカウントのトークンを生成します。共有対象のポートフォリオとInstagramアカウントが正しいことを確認します。広告アカウントは任意です。
6. GitHub Repository Secret `INSTAGRAM_ACCESS_TOKEN`に保存します。チャット、ソース、Workflowの入力欄には貼り付けません。

Unified LoginではFacebookページは必須ではありません。この開発者向けテストトークン生成と、一般利用者向けOAuthログインの実装は別です。後者には実際のリダイレクトURLと受信処理が必要です。仮のURLを入力してログイン基盤の完成扱いにはしません。

読取確認に必要な権限は`instagram_basic`です。テンプレートには投稿・メッセージ・コメント・広告などの権限も含まれ得ます。設定の「プレビュー」→「Edit permissions」で見直せます。この接続確認は広告/DM/投稿APIを呼びませんが、設定済みの追加権限を自動削除する機能ではありません。

## GitHub Actionsで確認

1. Actions → **Instagram connection check (no posting)** → Run workflow。
2. Branchは`main`。`expected_username`にInstagramプロフィールの正確なユーザーネームを入力します。Threadsの名前とは異なる場合があります。`@`は省略できます。
3. 実行後、`connection` → `Check Instagram account identity without posting`のJSONを確認します。
4. `connected: true`かつ期待した`username`を確認できたら、`userId`をRepository Secret `INSTAGRAM_USER_ID`に保存します。以後はこのIDも照合します。

トークンはAuthorizationヘッダーだけに渡し、出力はアカウント名・IDと確認状態に限定します。DBやSupabaseキーは不要です。手元では`npm run instagram:check`を使用できますが、シェル履歴へトークンを記録しないよう環境変数を安全に渡してください。

## Unified Login固有の取得方法

APIホストは`graph.facebook.com/v27.0`。このトークンの`/me`はInstagramアカウントではなく、連携用システムユーザーです。

`INSTAGRAM_USER_ID`未設定時はGET `/me/assigned_instagram_accounts?fields=id,username`で共有されたアカウントを調べ、期待ユーザーネームで選択します。続いてGET `/{id}?fields=id,username`で再照合します。設定済みIDがあれば後者だけを実行します。ページ送りは最大3ページで、プロバイダーの`paging.next`を直接開かず固定ホストとカーソルから組み立てます。

旧Instagram Login設定は`instagramLoginMode: instagram`、ホスト`graph.instagram.com`です。新規の標準設定は`instagramLoginMode: unified`。旧設定との混同を防ぐため今回の接続確認CLIはUnified Loginだけに対応します。

主な停止理由:

| エラー | 確認すること |
| --- | --- |
| `instagram_token_invalid_or_expired` | 同じMetaアプリでトークンを生成し直し、Secretを更新 |
| `instagram_basic_permission_required` | トークンに読取権限があるか |
| `instagram_account_not_found` | 正しいIG名・共有アカウント・ポートフォリオか |
| `instagram_account_mismatch` | 保存済みIDとIG名が同じアカウントか |
| `instagram_discovery_limit` | 共有対象が多数なら対象のIG IDを`INSTAGRAM_USER_ID`に設定 |
| `instagram_rate_limited` | しばらく待って再実行 |

接続成功は投稿権限、返信権限、トークン有効期限、ビジネス認証、アプリレビューの完了を意味しません。SUATは設定によって無期限でも、取消しやアセット変更で失効します。CLIは本番投稿を引き続き拒否します。

## 公式資料

- [Unified Login概要](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login)
- [Get Started（割り当て済みInstagramアカウントの取得）](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started)
- [認証とシステムユーザートークン](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication)
- [Instagram User](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user)

画面文言やAPIバージョンの変更時は公式資料を再確認します。
