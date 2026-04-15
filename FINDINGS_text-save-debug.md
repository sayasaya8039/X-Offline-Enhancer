# Findings: テキストが保存されず画像だけ保存される件

作成日: 2026-04-15
対象: `D:\NEXTCLOUD\extensions\X_Offline_Enhancer`
調査方式: Delegate Mode / 5仮説並列調査 / 2ラウンド反証

## 結論

現時点のコンセンサスは以下です。

1. 主因は `content_script.js` の保存対象同定がクリックしたツイートに閉じておらず、`collectThreadTweets()` がページ全体の `article` を収集してしまう設計ズレです。
2. その上で、本文抽出が `[data-testid="tweetText"]` + `innerText` の単一経路に依存しているため、正しい `article` を拾っても `tweet.text === ''` が起こり得ます。
3. Service Worker / IndexedDB / Side Panel は主犯ではありませんが、不完全データを拒否せず保存・表示するため、上流の不整合を「画像だけ保存された」症状として固定化しています。

要約すると、最も筋の良い説明は `H2(対象ズレ) + H1(本文抽出脆弱性) + H5(保存境界で未拒否)` の複合要因です。

## 仮説の最終順位

| 順位 | 仮説 | 判定 | 要旨 |
|---|---|---|---|
| 1 | H2 | supported | クリックしたツイート ID と、実際に保存される `tweets[]` の収集対象が一致していない |
| 2 | H1 | supported as contributing factor | `tweetText` 単一セレクタ依存により `tweet.text` が空化し得る |
| 3 | H5 | supported as guardrail failure | 空本文や不整合データでも保存成功扱いになる |
| 4 | H4 | weakened | UI は主犯ではなく、空本文をそのまま見せる増幅器 |
| 5 | H3 | weakened | SW/DB は本文を削っておらず、主因とは考えにくい |

## 根拠

### 1. 保存対象がクリックしたツイートに閉じていない

- `handleSave()` はクリックされた `articleEl` から `tweetId` だけ取得し、その直後に引数なしの `collectThreadTweets()` を呼んでいます。[content_script.js:181](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:181) [content_script.js:192](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:192)
- `collectThreadTweets()` は `document.querySelectorAll('article[data-testid="tweet"]')` を全件収集し、見つからなければさらに `article[role="article"]` へ広げます。クリック元記事、会話コンテナ、対象スレッドへの絞り込みはありません。[content_script.js:127](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:127) [content_script.js:130](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:130)
- 保存される `threadData.id` はクリックしたツイート ID ですが、`threadData.tweets` はページ全体から集めた配列です。[content_script.js:216](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:216) [content_script.js:219](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:219)
- 一覧も Reader も `thread.tweets[0]` を先頭基準として表示するため、クリックしたツイートと違う `article` が先頭に来ると、別著者・別本文・空本文がそのまま見えます。[sidepanel.js:336](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:336) [sidepanel.js:433](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:433)

### 2. 本文抽出経路が脆い

- 本文は `[data-testid="tweetText"]` の単一セレクタに依存し、見つからなければ空文字を入れます。[content_script.js:47](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:47) [content_script.js:48](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:48)
- 代替経路として `textContent`、複数ノード結合、別セレクタ、抽出失敗フラグなどは存在しません。
- 画像抽出は本文抽出と独立した `img[src*="pbs.twimg.com/media"]` で動くため、本文だけ空で画像だけ入ることはコード上可能です。[content_script.js:70](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:70) [content_script.js:71](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:71)

### 3. 不完全データが保存成功扱いになる

- 保存前の検証は `tweets.length === 0` だけです。`tweet.text` の非空条件や、クリック ID と `tweets[]` の整合性検証はありません。[content_script.js:192](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:192) [content_script.js:193](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\content_script.js:193)
- Service Worker でも `thread.id` と `Array.isArray(thread.tweets)` しか見ず、内容が不完全でも保存します。[service_worker.js:176](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\service_worker.js:176) [service_worker.js:181](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\service_worker.js:181) [service_worker.js:186](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\service_worker.js:186)
- IndexedDB 側は `store.put(thread)` による全置換保存で、不完全レコードをそのまま固定化します。[lib/db-esm.js:55](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\lib\db-esm.js:55) [lib/db-esm.js:61](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\lib\db-esm.js:61)

### 4. UI は主犯ではないが症状を強く見せる

- 一覧表示は `firstTweet?.text || ''` を使うため、先頭 tweet の本文が空なら空欄のままです。[sidepanel.js:368](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:368) [sidepanel.js:370](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:370)
- Reader でも各 tweet について `tweet.text || ''` を描画し、その後で画像を別ブロックで追加します。したがって空本文でも画像だけ表示されます。[sidepanel.js:465](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:465) [sidepanel.js:470](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:470) [sidepanel.js:475](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\sidepanel.js:475)
- CSS には本文だけを消す条件は見当たらず、UI は空データをそのまま見せているだけです。

### 5. SW/DB が本文を削る証拠はない

- `SAVE_THREAD` 処理で本文を削るロジックはありません。変形は `htmlContent` の削除と `timestamp` 補完だけです。[service_worker.js:184](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\service_worker.js:184) [service_worker.js:185](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\service_worker.js:185)
- クリーンアップ処理が更新するのは `imageCache` のみで、本文や `tweets[]` には触れていません。[lib/db-esm.js:223](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\lib\db-esm.js:223) [lib/db-esm.js:226](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\lib\db-esm.js:226) [lib/db-esm.js:263](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\lib\db-esm.js:263) [lib/db-esm.js:266](D:\NEXTCLOUD\extensions\X_Offline_Enhancer\lib\db-esm.js:266)

## 反証で落ちた説

### H3: SW/DB が本文を落としている

否定的です。本文を削るコードが見当たらず、保存層は「不完全データを拒否しない」だけです。

### H4: Side Panel が本文を隠している

否定的です。本文が DB にあれば表示できます。問題は表示前に空本文が保存されている点です。

## 合意済みの失敗モード

最も整合する失敗モードは以下です。

1. ユーザーがツイート A の保存ボタンを押す
2. `collectThreadTweets()` がページ全体から tweet B/C/... を混ぜて回収する
3. その中の一部 tweet は `tweetText` が取れず `text === ''` になる
4. それでも `threadData.id = A` で不完全な `tweets[]` が保存成功する
5. Side Panel は `tweets[0]` と `tweet.text || ''` をそのまま描画するため、画像だけ保存されたように見える

## 次にやるべき確認

実機で最短確認するなら以下の順です。

1. 保存失敗が起きるページで、クリックしたツイート ID と `collectThreadTweets().map(t => [t.id, t.text.length])` を同時採取する
2. 同じページで、クリックした `article` に対して `article.querySelector('[data-testid="tweetText"]')` が `null` か確認する
3. IndexedDB 内の該当レコードを確認し、`thread.tweets[].text` が空なのか、別ツイートが先頭に来ているのかを確認する

## 修正優先度

調査結果から見た優先順位は以下です。

1. 保存対象をクリックしたツイート起点に閉じる
2. 本文抽出を単一セレクタ依存から外す
3. 保存境界で空本文・対象不整合を拒否する
4. UI で空本文のまま保存されたケースを明示表示する

## 調査メモ

- 実装変更は未実施
- ランタイム再現は未実施
- 本書は静的コード読解と 5 Agent の相互反証結果を統合したもの
