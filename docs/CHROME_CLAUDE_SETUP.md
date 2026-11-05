# ピッと栄養 GAS版 セットアップ指示書（Claude in Chrome 用）

GitHub に置いた `pitto-eiyo` のコードから、Claude in Chrome がスプレッドシート・Apps Script・GitHub Pages・Google ログインを順に設定するための手順書。人間は最初にリポジトリを push し、途中の承認ダイアログだけ対応する。
（同じ内容の閲覧用ページ: https://claude.ai/artifact/5C7DKg8fvibNuYfYeNe2cp）

## 使い方

人間が先に 1 回だけやることは「リポジトリを GitHub に置く」こと（5 分）。あとは Claude in Chrome がこの手順書を上から順に実行し、承認ダイアログが出たときだけ人間が対応する。

1. GitHub で新しいリポジトリ `pitto-eiyo` を作る（private でよい）。
2. ローカルの `pitto-eiyo` フォルダ（zip を展開したもの）を push する。git を使わない場合は、GitHub の「Add file → Upload files」にフォルダの中身をドラッグしてコミットする（`.github` フォルダも含める）。

```bash
cd pitto-eiyo
git init -b main
git add .
git commit -m "ピッと栄養 GAS版 初期コミット"
git remote add origin https://github.com/{{GITHUB_USER}}/pitto-eiyo.git
git push -u origin main
```

3. 下の「入力情報」の表を埋める。
4. Chrome でこの手順書を開いたまま、Claude in Chrome に次の依頼文を貼る。

```
開いているタブの手順書「ピッと栄養 GAS版 セットアップ指示書（Claude in Chrome 用）」に従って、
「入力情報」の値を使い、フェーズ A → B → C → D の順に実行してください。
各フェーズの最後に「動作確認と報告テンプレート」の確認を行い、テンプレートの形で報告してから次に進んでください。
手順書が予告していない承認画面、2 段階認証、パスワード入力、支払いが出たら止まって私に知らせてください。
```

## Claude in Chrome へのルール

- 手順は上から順に進め、各行の「確認」を満たしてから次へ進む。満たせないときは原因を 2 回まで探し、それでも駄目なら止まって報告する。
- 画面のラベルが手順書と少し違うときは、同じ意味の項目を選ぶ（Google と GitHub の UI は文言が変わることがある）。
- URL・ID・キーは手順書と「入力情報」から正確にコピーし、推測しない。
- 秘密情報（API キー、クライアント ID）は、手順書が指定した場所（Apps Script のスクリプト プロパティ、`web/config.js`）以外に書かない。チャットでの報告には末尾 4 文字だけを書く。
- Google の承認画面（「権限を確認」「このアプリは Google で確認されていません」「アクセスを許可」）は、手順書が予告している行では「詳細」→「ピッと栄養 API（安全ではないページ）に移動」→「許可」で進めてよい。それ以外の承認、支払い、2 段階認証、パスワード入力は止まって人間に渡す。
- 指定されたリポジトリ・スプレッドシート・Apps Script プロジェクト・Cloud プロジェクト以外は変更しない。既存のものを削除しない。
- 長いコードは「生ファイルのタブで Ctrl+A → Ctrl+C」→「エディタ内をクリック → Ctrl+A → Ctrl+V → Ctrl+S」で貼り付ける。1 行ずつ打ち込まない（エディタの自動インデントと括弧の自動補完でコードが壊れる）。
- 待ち時間が必要な操作（GitHub Actions、Pages の反映）は 30 秒ごとに再読み込みして最大 5 分待つ。
- 各フェーズの終わりに「報告テンプレート」の該当行を埋めて報告する。

## 入力情報（人間が埋める）

`{{…}}` の値を埋めてから Claude in Chrome に渡す。手順書の中の `{{GITHUB_USER}}` はすべてこの表の値に読み替える。

| 項目 | 値 | 使う場所 |
| --- | --- | --- |
| GitHub ユーザー名（または組織名） | `{{GITHUB_USER}}` | 生ファイルの URL、Pages の URL |
| リポジトリ名 | `pitto-eiyo` | 同上（変えた場合は手順書の `pitto-eiyo` をすべて読み替える） |
| ブランチ名 | `main` | 生ファイルの URL、Actions |
| Google アカウント（スプレッドシート・GAS・Cloud の所有者） | `{{GOOGLE_ACCOUNT}}` | Chrome でこのアカウントにログイン済みであること |
| スプレッドシート名 | `ピッと栄養 DB` | フェーズ A |
| Apps Script プロジェクト名 | `ピッと栄養 API` | フェーズ A |
| テスターのメール（カンマ区切り。空なら制限なし） | `{{ALLOWED_EMAILS}}` | フェーズ C（テストユーザー）、D（利用者制限） |
| Claude API キー（OCR を使うとき） | 人間がフェーズ D で直接入力する（この表には書かない） | フェーズ D |

リポジトリのファイルを生のテキストで開く URL は `https://github.com/{{GITHUB_USER}}/pitto-eiyo/raw/main/<パス>`。private リポジトリでも、GitHub にログイン済みの Chrome ならこの形で開ける。フェーズ A で使うファイルは 2 つだけ: `gas/bundle/Code.gs`（GAS の全コードを 1 ファイルにまとめたもの、約 1,290 行）と `gas/bundle/appsscript.json`。

## フェーズ A: スプレッドシートと Apps Script（API を公開する）

ゴール: `https://script.google.com/macros/s/…/exec?action=health` が `{"ok":true,…}` を返す。所要 10〜15 分。

| # | 操作 | 確認 |
| --- | --- | --- |
| A1 | Chrome で `https://sheets.new` を開き、左上のファイル名を `ピッと栄養 DB` にする。「ファイル → 設定」でロケール「日本」、タイムゾーン「(GMT+09:00) 東京」にして保存 | タブのタイトルが `ピッと栄養 DB` |
| A2 | メニュー「拡張機能 → Apps Script」を開く。左上の「無題のプロジェクト」をクリックして `ピッと栄養 API` に変更 | 新しいタブでエディタが開き、ファイル一覧に `コード.gs` がある |
| A3 | 別タブで `https://github.com/{{GITHUB_USER}}/pitto-eiyo/raw/main/gas/bundle/Code.gs` を開き、ページ内をクリック → Ctrl+A → Ctrl+C | 1 行目が `/* ピッと栄養 GAS 一体版` で始まる |
| A4 | エディタのタブに戻り、`コード.gs` の本文をクリック → Ctrl+A → Ctrl+V → Ctrl+S | 最終行が `/* ===================== END OF BUNDLE ===================== */`。行数が約 1,290。保存時に赤いエラーが出ない |
| A5 | 左の歯車「プロジェクトの設定」を開き、「「appsscript.json」マニフェスト ファイルをエディタで表示する」にチェック | エディタのファイル一覧に `appsscript.json` が出る |
| A6 | `https://github.com/{{GITHUB_USER}}/pitto-eiyo/raw/main/gas/bundle/appsscript.json` を開いて Ctrl+A → Ctrl+C。エディタで `appsscript.json` を開き、本文をクリック → Ctrl+A → Ctrl+V → Ctrl+S | `"timeZone": "Asia/Tokyo"` と `"access": "ANYONE_ANONYMOUS"` が含まれる |
| A7 | 「プロジェクトの設定」の下の「スクリプト プロパティ」で「スクリプト プロパティを追加」→ プロパティ `AUTH_MODE` 値 `dev`、もう 1 行 `DEBUG` 値 `1` →「スクリプト プロパティを保存」 | 一覧に 2 件表示される |
| A8 | エディタ（「エディタ」アイコン）に戻り、上部の関数選択で `setupSheets` を選んで「実行」。承認画面が出たら「権限を確認」→ アカウントを選択 →「詳細」→「ピッと栄養 API（安全ではないページ）に移動」→「許可」。承認後にもう一度「実行」 | 実行ログに「実行完了」。スプレッドシートに `users` `user_profiles` `products` `food_logs` `daily_summaries` `product_images` `product_suggestions` の 7 タブができる |
| A9 | 関数選択で `selfCheck` を選んで「実行」 | 実行ログの JSON に `"ok":true` と `"missing":[]`。`"modules_ok":false` なら A3〜A4 をやり直す |
| A10 | 右上「デプロイ → 新しいデプロイ」→ 左の歯車で「ウェブアプリ」→ 説明 `v1`、次のユーザーとして実行「自分」、アクセスできるユーザー「全員」→「デプロイ」。承認が出たら A8 と同じく許可 | 「ウェブアプリ」の URL `https://script.google.com/macros/s/…/exec` が表示される。コピーして控える（以下「exec URL」） |
| A11 | 新しいタブで `exec URL` の末尾に `?action=health` を付けて開く | `{"ok":true,"data":{"version":"1.0.0",…,"auth_mode":"dev"}}` が表示される |

「アクセスできるユーザー」は必ず「全員」（匿名ユーザーを含む）にする。認証はアプリ側の ID トークンで行うため、GAS 側のアクセス制限は使わない。Google Workspace のアカウントで「全員」が選べないときは、「つまずいたとき」を見る。

## フェーズ B: GitHub Pages でアプリを公開する

ゴール: `https://{{GITHUB_USER}}.github.io/pitto-eiyo/` でアプリが開き、ホームの「記録」の右に「同期済み」と出る。所要 5〜10 分。リポジトリに含まれる `.github/workflows/pages.yml` が `web/` をそのまま公開する。

| # | 操作 | 確認 |
| --- | --- | --- |
| B1 | `https://github.com/{{GITHUB_USER}}/pitto-eiyo/settings/pages` を開き、「Build and deployment → Source」を `GitHub Actions` にする | Source の表示が GitHub Actions になる（保存ボタンはなく選んだ時点で反映） |
| B2 | `https://github.com/{{GITHUB_USER}}/pitto-eiyo/blob/main/web/config.js` を開き、鉛筆アイコン（Edit this file）→ `apiUrl: ''` の引用符の中にフェーズ A の exec URL を入れる →「Commit changes…」→ メッセージ `config: apiUrl を設定` → `main` に直接コミット | ファイルに `apiUrl: 'https://script.google.com/macros/s/…/exec',` と表示される |
| B3 | `https://github.com/{{GITHUB_USER}}/pitto-eiyo/actions` を開き、「Deploy web to GitHub Pages」の最新の実行が緑のチェックになるまで待つ（1〜2 分）。実行が始まらない場合は左のワークフロー名 →「Run workflow」 | 最新の実行が成功 |
| B4 | `https://{{GITHUB_USER}}.github.io/pitto-eiyo/` を開く | 「ピッと栄養」のホーム画面。「記録」の右に「同期済み」。開発モードなのでログイン画面は出ない（「API未設定」なら B2 を確認） |
| B5 | 「JANを入力」→ `4901234567894` を入力 →「このコードで検索」 | 「商品を登録」画面に移る（未登録なので正常）。「← 戻る」で戻る |

Pages の URL は Settings → Pages の上部にも表示される。リポジトリ名を変えた場合は URL もそれに合わせる。

## フェーズ C: Google ログインに切り替える

ゴール: アプリに「Google でログイン」ボタンが出て、ログイン後はそのアカウントの記録だけが表示される。誰かに URL を渡す前に必ず行う（開発モードは全員が同じユーザーになる）。所要 10〜15 分。

| # | 操作 | 確認 |
| --- | --- | --- |
| C1 | `https://console.cloud.google.com/projectcreate` を開き、プロジェクト名 `pitto-eiyo` で「作成」。作成後に通知からそのプロジェクトを選択 | 上部のプロジェクト選択が `pitto-eiyo` |
| C2 | 左メニュー「API とサービス → OAuth 同意画面」（新しい UI では「Google Auth Platform → ブランディング」）。ユーザーの種類: 個人の Gmail でも使うなら「外部」、Workspace 内だけなら「内部」。アプリ名 `ピッと栄養`、ユーザー サポートメールとデベロッパーの連絡先に入力情報の Google アカウント → 保存。スコープの追加は不要 | 同意画面（ブランディング）が保存される |
| C3 | 「外部」にした場合: 「対象（Audience）」→「テストユーザー」に入力情報のテスターのメールを追加。公開ステータスは「テスト」のまま | テストユーザー一覧にメールが並ぶ |
| C4 | 「認証情報 → 認証情報を作成 → OAuth クライアント ID」（新しい UI では「クライアント → クライアントを作成」）。アプリケーションの種類「ウェブ アプリケーション」、名前 `pitto-eiyo web`。「承認済みの JavaScript 生成元」に `https://{{GITHUB_USER}}.github.io` を追加（パスは付けない。ローカル開発もするなら `http://localhost:8787` も）。リダイレクト URI は空のまま →「作成」 | クライアント ID（`…apps.googleusercontent.com`）が表示される。控える。クライアント シークレットは使わないので保存しない |
| C5 | Apps Script（`ピッと栄養 API`）の「プロジェクトの設定 → スクリプト プロパティ → スクリプト プロパティを編集」で `GOOGLE_CLIENT_ID` = クライアント ID を追加し、`AUTH_MODE` の値を `google` に変えて保存 | 一覧に `AUTH_MODE = google` と `GOOGLE_CLIENT_ID` がある。`exec URL?action=health` の `auth_mode` が `google` になる |
| C6 | GitHub の `web/config.js` を B2 と同じ手順で編集し、`googleClientId: ''` の引用符の中にクライアント ID を入れてコミット（メッセージ `config: Google ログインを有効化`） | Actions の実行が成功 |
| C7 | 2〜3 分待ってから `https://{{GITHUB_USER}}.github.io/pitto-eiyo/` をシークレット ウィンドウで開く（古い config.js のキャッシュを避ける） | 「Google でログイン」ボタンが出る。テストユーザーのアカウントでログインするとホームが表示され、「同期済み」。スプレッドシートの `users` タブに 1 行増える |

ログイン後に「このアカウントではまだ利用できません」と出るときは、スクリプト プロパティ `ALLOWED_EMAILS` / `ALLOWED_DOMAINS` にそのアカウントが含まれていない（フェーズ D）。同意画面が「テスト」の間は、C3 のテストユーザー（最大 100 人）だけがログインできる。

## フェーズ D（任意）: OCR・夜間集計・利用者制限

どれも Apps Script の「プロジェクトの設定 → スクリプト プロパティ」に追加する。保存した瞬間から有効で、再デプロイは不要。

| 目的 | 操作 | 確認 |
| --- | --- | --- |
| 栄養成分表示の写真から自動入力（OCR） | 人間が https://console.anthropic.com で API キーを発行し、`CLAUDE_API_KEY` として直接入力する（Claude in Chrome はキーをチャットに書かない）。モデルを変えるときは `CLAUDE_MODEL`（既定 `claude-opus-5-5`）。Gemini にするなら `OCR_PROVIDER` = `gemini` と `GEMINI_API_KEY` | アプリの「商品を登録」で「栄養成分表示を撮影して自動入力」が数値を埋める（スマホで確認） |
| 手料理・一般食品（ご飯・みそ汁など約 80 品）を検索して記録できるようにする | エディタの関数選択で `setupFoods` を選んで「実行」（再実行すると標準値に戻る） | ホームの「料理・食品を検索」で「ごはん」と入れると「ご飯（白米）茶碗1杯（150g） 234 kcal」が出る |
| 夜間に日次サマリを全件再計算 | エディタの関数選択で `setupNightlyTrigger` を選んで「実行」（承認が出たら A8 と同じく許可） | 左メニュー「トリガー」に `recomputeAllSummaries`（日付ベース、毎日 午前 3〜4 時）が 1 件 |
| 利用者をテスターに限定 | `ALLOWED_EMAILS` に入力情報のメールをカンマ区切りで（ドメインごとなら `ALLOWED_DOMAINS` に `example.co.jp` の形で） | 一覧外のアカウントでログインすると「このアカウントではまだ利用できません」 |
| 管理者（商品情報をその場で修正でき、登録した商品が「確認済み」になる） | `ADMIN_EMAILS` に自分のメール | 設定画面のアカウント欄に「管理者」と出る |
| 未登録商品の商品名と栄養成分をウェブ検索で自動取得（ウェブ照会） | `CLAUDE_API_KEY` を設定するだけで有効（既定 `WEB_LOOKUP=1`）。5 項目そろって信頼度 0.7 以上なら商品マスタに `source=web` で保存して即表示、それ以外は登録フォームの初期値として表示。止めるなら `WEB_LOOKUP` = `0`、保存せず常に確認させるなら `WEB_LOOKUP_AUTOSAVE` = `0` | 未登録の JAN を読むと「ウェブ検索・要確認」タグ付きの商品カードか、数値入り（黄色＝要確認）の登録画面が出る |
| 未登録商品の商品名を Yahoo!ショッピングから補完 | https://e.developer.yahoo.co.jp/ でアプリケーション ID（Client ID）を発行し `YAHOO_CLIENT_ID` に | 未登録の JAN で登録画面を開くと商品名が入っている |
| エラーの詳細を応答に含めない（公開後） | `DEBUG` を削除するか `0` に | health は引き続き `ok:true` |

## 動作確認と報告テンプレート

各フェーズの最後に次を確認し、結果をテンプレートの形で報告する。

1. `exec URL?action=health` が `{"ok":true,…}`。`auth_mode` はフェーズ A・B では `dev`、フェーズ C 以降は `google`。
2. アプリのホームで「同期済み」。「JANを入力」→ `4901234567894` で登録画面に移り、「← 戻る」で戻れる。「月次」タブで「この月の記録はありません」か集計が出る（エラーが出ない）。
3. フェーズ C 以降: シークレット ウィンドウで開くとログインボタンが出て、ログイン後にホームが表示される。スプレッドシートの `users` タブにそのアカウントの行がある。
4. 設定画面で性別・生まれた年・体重を入れて「目標を計算して保存」すると「目標を保存しました」と出て、`user_profiles` タブに 1 行できる。

報告テンプレート（埋めて報告する。キーと ID は末尾 4 文字だけ）:

```
## ピッと栄養 セットアップ報告（フェーズ ○ まで完了）
- スプレッドシート: <URL>
- Apps Script プロジェクト: <URL>
- exec URL: https://script.google.com/macros/s/…/exec
- health の応答: {"ok":true, "auth_mode": "…"}
- GitHub Pages URL: https://….github.io/pitto-eiyo/
- スクリプト プロパティ: AUTH_MODE=…, DEBUG=…, GOOGLE_CLIENT_ID=…（末尾4文字）, その他=…
- OAuth: クライアント ID …（末尾4文字）/ 同意画面: 外部・テスト（テストユーザー n 人）
- 確認結果: 1 ○ / 2 ○ / 3 ○ / 4 ○
- 未完了・人間の対応が必要な項目: …
```

## 更新するとき・つまずいたとき

コードを更新したときの手順。

1. GAS: `gas/bundle/Code.gs` を A3〜A4 の手順で貼り直す →「デプロイ → デプロイを管理 → 鉛筆 → バージョン: 新バージョン → デプロイ」。exec URL は変わらない（「新しいデプロイ」を作ると URL が変わるので使わない）。
2. web/: `main` に push するだけで Actions が公開する（1〜2 分）。スマホ側はアプリを開き直すと新しい版になる。
3. 共通ロジック（`shared/logic.js`）を変えたときは、ローカルで `npm run sync` と `npm run bundle` を実行してから push する。

| 症状 | 原因と対処 |
| --- | --- |
| A4 の保存時に赤い「構文エラー」 | 貼り付けが途中で切れたか、1 行ずつ入力して括弧が自動補完された。エディタで Ctrl+A → Delete してから A3〜A4 をやり直す |
| `selfCheck` の `missing` に名前がある | そのモジュールの部分が貼れていない。最終行が `END OF BUNDLE` で終わっているか確かめ、A3〜A4 をやり直す |
| health が `"code":"unknown_action"` | URL の `?action=health` が欠けている |
| health が Google のログイン画面や「アクセス権が必要」の HTML | デプロイの「アクセスできるユーザー」が「全員」でない。「デプロイを管理 → 鉛筆」で直して新バージョンでデプロイ |
| アプリ右上が「API未設定」 | `web/config.js` の `apiUrl` が空。B2 をやり直し、Actions 成功後にシークレット ウィンドウで開く |
| アプリが「通信できませんでした」 | exec URL の誤りか、デプロイが更新されていない。ブラウザで health を開いて確認 |
| ログイン直後に「ログインの有効期限が切れました」が繰り返される | `GOOGLE_CLIENT_ID`（スクリプト プロパティ）と `googleClientId`（config.js）が一致していないか、`AUTH_MODE` が `google` でない |
| ログインボタンを押すと Google が「エラー 400: origin_mismatch」や「このアプリはブロックされています」 | C4 の「承認済みの JavaScript 生成元」が Pages のオリジン（`https://{{GITHUB_USER}}.github.io`、パスなし）と違う。テストユーザーでないアカウントのときは C3 に追加 |
| 「このアプリは Google で確認されていません」 | 想定内。「詳細」→「（安全ではないページ）に移動」で進む。機密スコープを使っていないので、同意画面を「本番」にしても Google の審査は不要 |
| 「アクセスできるユーザー」に「全員」が無い | Workspace の管理者設定で外部公開が無効。管理者に Apps Script の「ウェブアプリを全員に公開」を許可してもらうか、個人の Google アカウントで A1 からやり直す |
| カメラが起動しない | Pages は HTTPS なので通常は動く。iOS のホーム画面モードで動かない端末は「写真から読む」を使う |
| OCR が「読み取りサービスでエラー」 | `CLAUDE_API_KEY` が未設定か無効。Apps Script の「実行数」でエラー内容を見る（`DEBUG=1` の間は応答にも出る） |
