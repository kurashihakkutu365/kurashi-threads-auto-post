# Threads接続確認（投稿なし）

## 準備済みのもの

* MetaアプリにThreadsユースケースを追加。
* `threads_basic`、`threads_content_publish`を追加。
* 投稿用ThreadsアカウントをThreadsテスターへ招待し、Threads側で承認。
* Metaのユーザートークン生成ツールから生成したトークンを、GitHub Repository Secret `THREADS_ACCESS_TOKEN`へ保存。

トークンはチャット、ソースコード、workflowの入力欄、URL、スクリーンショットへ載せない。
スマホで認証後の画面が白くなり取得できなかった場合、PCブラウザでの操作を検証する。
原因未確認のまま任意のコールバックURLを入力したり、ユーザー名をIDとして保存したりしない。

## 接続確認を実行

1. GitHubのActionsで **Threads connection check (no posting)** を開く。
2. **Run workflow**でbranchを`main`にする。
3. `expected_username`が実際の投稿用アカウント名であることを確認する。
   今回の設定例は`kurashi_hakkutsu365`。トークンやアプリ名をこの欄へ入力しない。
4. **Run workflow**を押す。
5. 完了後、`connection`ジョブの **Check account identity without posting** を開く。

成功時の出力例（架空の数値）:

```json
{
  "connected": true,
  "platform": "threads",
  "username": "kurashi_hakkutsu365",
  "userId": "123456789",
  "dryRun": true,
  "publishingTested": false,
  "replyPermissionsVerified": false,
  "tokenExpiryVerified": false
}
```

表示された実際の`userId`はThreadsアプリスコープのユーザーID。
必要に応じて、GitHub Repository Secret `THREADS_USER_ID`へこの数値をそのまま保存する。
`123456789`は説明用でありコピーしない。
アプリID・Threadsのユーザーネーム・FacebookのユーザーIDは代わりにならない。
既に`THREADS_USER_ID`が登録されている場合、そのIDとも照合する。

この操作は公式APIへ`GET /me?fields=id,username`を1回だけ送る。
トークンはAuthorizationヘッダーに入れ、出力はID・照合済みユーザーネームと固定の状態のみ。
公開コンテナ作成、投稿、返信、画像取得、有料AI、DB書込み、トークン更新は行わない。
緊急停止・規約停止・Threads停止・DRY_RUN解除時はAPIを呼ぶ前に停止する。

## エラーの確認

| エラー | 次に確認するもの |
|---|---|
| `threads_token_missing` | Repository Secretの名前が`THREADS_ACCESS_TOKEN`か |
| `threads_token_format_invalid` | コピーした値に改行や別の説明文が混ざっていないか |
| `threads_expected_username_required` | workflowのユーザーネーム欄が正しいか |
| `threads_token_invalid_or_expired` | トークンが有効か、失効・取り消し・コピー誤りがないか |
| `threads_basic_permission_required` | アプリの権限と、アカウント側の認証が済んでいるか |
| `threads_account_mismatch` | 認証したアカウントと期待ユーザーネーム、既存USER_IDが一致するか |
| `threads_rate_limited` | API制限。連続で再実行せず、時間を置く |
| `threads_connection_failed` | 通信・タイムアウト・リダイレクト。トークンをURLに貼って調べない |
| `threads_response_invalid` / `threads_api_error` | 応答が想定外。出力の固定エラーコードで調べる |

HTTP 400内のMeta OAuth error 190も期限切れ/無効なトークンとして扱う。
プロバイダーのエラーメッセージや生レスポンスはログへ出さない。自動再試行もしない。

## 成功しても本番開始ではない

プロフィール取得の成功は`threads_basic`による読み取りの確認。
公開権限・返信権限・トークン有効期限・更新処理・画像権利・楽天商品情報・公開URLは別途確認する。
`THREADS_USER_ID`を設定しただけでCLIの本番停止条件は解除されない。
API権限や有効期限を「接続成功」で確認済みとみなさない。

## 公式仕様の確認

2026-11-09（Asia/Tokyo）、以下の公式資料で、プロフィール取得・必要な`threads_basic`・`/me`例を確認。

* https://developers.facebook.com/docs/threads/threads-profiles
* https://developers.facebook.com/docs/threads/reference/user

この変更の自動テストでは実ユーザーのトークンを使わない。
利用者の実アカウントでの成功は、上記の手動workflowの結果で判断する。
