# 画像許諾の登録

楽天API画像URLだけでは、取得・解析・転載・公開配信を許可されたことにならない。
権利者の利用条件を人間が確認し、用途ごとに明示的に登録する。
サンプルURL・架空の商品・ダミー証跡を実商品の承認に転用しない。

1. 商品を`state.sqlite`へ登録する。商品IDとGTIN、または人間が確認した同一商品キー/根拠が必要。
2. 自動取得が許可されている場合だけ画像を取得する。現在のCLIは自動ダウンロードしない。
3. オリジナルの画像バイト列のSHA-256を計算する。変換時は許可を確認し、別ハッシュと証跡を残す。
4. 下記形式のJSONを公開フォルダ外に作成し、実在するローカル画像のhashと保存先を設定する。
5. `node src/cli.js rights-import /absolute/private/image-rights.json`で検証・登録する。

```json
{
  "id": "shop:item:image-1",
  "productId": "shop:item",
  "source": "権利者が提供した取得元",
  "evidence": "利用許諾文書の管理番号・該当条項（文書そのものは非公開保管）",
  "approvedBy": "確認担当者",
  "approvedAt": "2026-11-07T00:00:00.000Z",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "permissions": {
    "download": false,
    "ai": false,
    "threads": false,
    "instagram": false,
    "site": false,
    "publicHosting": false,
    "transform": false
  },
  "hash": "実ファイルのSHA-256を64桁の小文字16進数で設定",
  "storagePath": "/absolute/private/image.jpg",
  "publicUrl": "",
  "publicUrlExpiresAt": "",
  "mime": "image/jpeg"
}
```

この例は許諾未設定であり投稿できない。根拠のある用途だけtrueにする。
画像AIを使うには外部AIサービスへの送信・処理が許諾範囲に含まれることを確認する。
公開URLはSNS取得時・一覧掲載時に有効で、公開配信の許可が必要。
InstagramはJPEGが必要。変換許可がなければ変換せず、別の対応画像か商品を選ぶ。
画像2枚は同一商品の異なるハッシュである必要がある。URLだけ違う同じ画像は拒否する。

登録済みであっても期限・権利撤回・URL期限を処理のたびに再確認する。
公開中ページ/ホストからの期限切れ素材の撤去は本番移行時にジョブを接続する。
許諾証跡や秘密キーをGitHub Pages、公開リポジトリ、公開artifactへ置かない。
