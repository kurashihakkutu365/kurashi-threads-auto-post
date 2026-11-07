# 費用の確認 — 2026-11-07

月1,000円は目標。実際の請求上限を保証しない。

## AI候補比較

公式 https://platform.openai.com/docs/pricing を取得し、Standard / Short contextのテキスト単価を確認。
単位はUSD/100万tokens。キャッシュ・Batch割引を前提にしない。

| 候補 | 入力 | 出力 | 入力1,000・出力200tokensを1回生成する例 |
|---|---:|---:|---:|
| gpt-6-luna | 0.10 | 0.50 | 0.0002 USD |
| gpt-6.1-terra | 1.00 | 5.00 | 0.002 USD |
| gpt-6.1-sol | 2.00 | 10.00 | 0.004 USD |

この比較はテキスト単価のみ。日本語品質、視覚評価能力、アカウントでの利用可否は未検証。
画像の料金計算・解像度・推論tokens・実プロンプト量はモデルごとに確認する必要がある。
品質未検証なので本番モデルは選定せず、`config/default.json`のモデル・価格・為替はnullを維持する。

仮に商品150回と日常30回を、各入力2,000・出力400tokensで処理すると、
合計入力360,000・出力72,000tokens。lunaの上記単価なら0.072 USD。
**仮の為替150円/USD**では10.8円だが、これは返信・画像解析・その他費用を含まない計算例。
実際のトークン量・為替の測定値ではなく、料金見積もりの保証には使わない。

課金を伴わない定型生成を既定にする。有料AIは`paidAiEnabled=false`とDRY_RUNで停止。
実験時も外部側ハード上限・モデル権限・単価確認・入力上限検証が必須。
不明な応答や通信切断では予約を解放せず、請求/使用量を照合する。

公式仕様:

* https://platform.openai.com/docs/guides/structured-outputs
* https://platform.openai.com/docs/guides/images-vision
* https://platform.openai.com/docs/api-reference/responses/create

上記でResponses、JSON Schema、input_image/base64形式を確認。
出力はローカルAJVでも検証し、商品の承認済み事実に含まれない文章を拒否する。
商品データは外部入力としてJSONで囲み、命令として扱わせない。

## 永続DB・画像配信

公式 https://supabase.com/pricing を同日に確認:

* Free: DB 500 MB、ファイル1 GB、egress 5 GB、cached egress 5 GB。
* 非アクティブ1週間でpause、active projectは2件までとの記載。

無料枠は採用判断の候補であり、現在接続・契約・本番動作はしていない。
リクエスト・キュー・認証・バックアップの制約も契約時に確認する。
手動/自動の暗号化オフサイトバックアップと容量監視を組み合わせる必要がある。
枠超過時は有料プランへ無条件移行せず停止する。

GitHub Actions・GitHub Pagesの料金と上限、Meta/Rakutenの利用条件はアカウント/契約依存。
Actionsは210回/月が目安で、返信の常時ポーリングに使わない。
Webhook基盤のプラン比較・選定は未完了。無料で正確な数分後の送信が保証されるとは扱わない。

## 予算管理

実装の段階制限は次の通り。

| 予約込み使用率 | 制限 |
|---|---|
| 50% | 通常 |
| 70% | 新規画像AIを停止。評価キャッシュを使用 |
| 85% | essential指定の有料文章処理だけ許可 |
| 95% | 新規有料AIを停止 |
| 100% | 新規課金予約を停止 |

画像300円・文章/返信200円のカテゴリ上限、日次呼出20回・tokens30,000も設定可能。
実請求は`actual_billed`、API使用量からの見積もりは`estimated`、未確定最大額は`reserved`で区別する。
実請求が見積もりを超えた場合は大きい方で停止判定する。
他アプリによる課金やプロバイダーの計測遅延をこのDBだけで防ぐことはできない。
