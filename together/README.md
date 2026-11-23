# 益起出發 Together For better

獎助學金、政府補助與競賽的查詢平台，前端和後端已經串接好，也有登入系統。

## 怎麼打開網站

1. 先安裝 Node.js：到 https://nodejs.org 下載 **LTS** 版本，安裝時一直按「下一步」。（只需要裝一次）
2. 解壓縮這個資料夾。
3. 雙擊啟動檔：
   - **Windows**：`start-windows.bat`
   - **Mac**：`start-mac.command`（第一次如果被擋，請按右鍵 →「打開」）
4. 瀏覽器會自動打開 `http://localhost:3000`。沒有自動打開的話，自己在網址列輸入這個網址。

跳出來的黑色視窗要一直開著，關掉網站就停了。

不要直接點兩下 `public/index.html`，那樣連不到後端。

## 資料夾裡有什麼

| 檔案 | 用途 |
| --- | --- |
| `server.js` | 後端：API、登入系統、提供網頁 |
| `public/intro.html` | 首頁介紹頁（`http://localhost:3000/`） |
| `public/index.html` | 查詢平台（`http://localhost:3000/app`） |
| `data/grants.json` | 獎助資料。直接改這個檔就能新增或修改，存檔後重新整理網頁就會更新 |
| `data/users.json` 等 | 有人註冊、訂閱後自動產生，不要分享給別人（裡面有帳號資料） |

## API 一覽

| 方法 | 路徑 | 用途 |
| --- | --- | --- |
| GET | `/api/grants` | 查詢獎助資料（支援篩選、排序、分頁） |
| GET | `/api/grants/meta` | 篩選選項與筆數 |
| GET | `/api/grants/:id` | 單筆資料 |
| POST | `/api/smart-search` | 把一句話轉成篩選條件 |
| POST | `/api/auth/register` | 註冊 |
| POST | `/api/auth/login` | 登入 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 目前登入的使用者 |
| PUT | `/api/me/profile` | 儲存個人資料（資格檢查用） |
| POST / DELETE | `/api/me/favorites/:id` | 收藏 / 取消收藏 |
| GET | `/api/me/tracker` | 我的申請追蹤 |
| PUT / DELETE | `/api/me/tracker/:id` | 更新 / 移除申請追蹤 |
| POST | `/api/subscriptions` | 訂閱電子報 |
| POST | `/api/host-inquiries` | 主辦方諮詢 |

`/api/grants` 可用的參數：`keyword`（可輸入多個詞、支援同義詞，例如「非獎金比賽」）、`cash`（`grant` 無償現金 / `noncash` 非現金或榮譽 / `equity` 股權投資）、`fundingType`、`group`、`applicant`、`identity`、`region`、`stage`、`expense`、`minAmount`、`openOnly=1`、`expiredOnly=1`、`verifiedOnly=1`、`favOnly=1`、`sort`（`recommended` / `amountDesc` / `deadlineAsc`）、`page`、`pageSize`。

## 安全性說明

- 密碼用 scrypt 加鹽雜湊後才存，不會存明碼。
- 登入狀態用 HttpOnly cookie，網頁上的程式讀不到。
- 同一個 IP 15 分鐘內登入失敗 10 次會暫時鎖住。
- 有擋跨站偽造請求（CSRF）。
- 正式上線時請用 HTTPS，並設定環境變數 `NODE_ENV=production`，cookie 才會加上 Secure。
- 資料存在 JSON 檔，適合練習與小規模使用；使用者變多時建議改用資料庫。


## 如何更新資料

所有資料都在 `data/grants.json`。用記事本或 VS Code 打開，改完存檔，回到網頁重新整理就會更新，不用重開網站。

**新增一筆**：打開 `data/template-new-item.json`，複製整段 `{ ... }`，貼到 `grants.json` 最後一筆後面，前面記得加逗號：

```
  { ...原本最後一筆... },
  { ...你新增的這筆... }
]
```

**各欄位怎麼填**

| 欄位 | 說明 |
| --- | --- |
| `id` | 編號，不能重複。前綴決定分類：`TW` 台灣補助與競賽、`SCH` 獎助學金、`ESG` 永續淨零、`GL` 國際資源、`BH` 競賽類別彙整 |
| `name`、`organization` | 名稱、主辦單位 |
| `fundingType` | 獎學金、政府補助、競賽獎金、專案贊助、公益補助、非現金資源、榮譽獎項、股權投資（後三種會標示為非現金或股權） |
| `applicants` | 誰能申請：個人、學生團隊、青年團隊、企業、非營利組織、研究人員、法人機構 |
| `identities` | 限定資格：不限、清寒/經濟弱勢、本國籍/台灣登記、在地設籍、女性創辦人… |
| `regions` | 地區：不限、臺北、新北、臺南、海外… |
| `stages`、`expenses`、`fields`、`years` | 計畫進度、經費用途、領域、年級；沒有限制就填 `["不限"]` |
| `amountMax` | 最高金額（台幣，只填數字，不加逗號）；沒有獎金填 `0` |
| `deadline` | 截止日，格式 `"2027-03-31"`；還沒公布填 `null`（不加引號） |
| `description` | 說明，用 `｜` 分段，每段寫成「標題：內容」。「資金性質：」這段會特別顯示 |
| `url` | 官方網址，要 `https://` 開頭 |
| `group`（選填） | 指定分類（`TW`、`SCH`、`ESG`、`GL`、`BH`），不填就看 `id` 前綴 |
| `cashNature`（選填） | 強制指定資金性質：`grant` 現金、`noncash` 非現金（例如獎品）、`equity` 股權 |
| `deadlineNote`（選填） | 截止日的補充，例如「經費用罄截止」「2026-11-30 12:00 截止」 |
| `applicantsDetail` 等（選填） | `applicantsDetail`、`identitiesDetail`、`regionsDetail`、`expensesDetail`、`fundingTypeDetail` 放原文寫法，詳情頁會優先顯示原文；篩選仍用沒有 Detail 的欄位 |
| `verifiedAt` | 查證日期，例如 `"2026-11-22"`；沒查證過填 `null`。有填的會顯示「已查證」 |

**改壞了怎麼辦**：如果存檔後格式有錯，網站會先沿用上一版資料，黑色視窗會顯示錯在第幾行。最常見的錯是少逗號、最後一筆後面多了逗號，或引號沒有成對。

`amountMax` 填 `null` 代表「金額依個別規定」，和填 `0`（沒有獎金）不一樣。`deadline` 也可以寫成 `2026-11-30T12:00:00+08:00`。

`data/grants-backup-before-merge.json` 是合併新資料前的備份，網站不會讀它，確認沒問題後可以刪掉。

## 分享網址給別人

**臨時分享（免費，電腦要開著）**
1. 雙擊 `share-windows.bat`（Mac：`share-mac.command`）。它會同時開好網站和分享通道，不用另外開 start 檔。
2. 第一次會詢問是否下載 Cloudflare 官方的分享工具 cloudflared，按任意鍵即可。
3. 黑色視窗會出現 `https://xxxx.trycloudflare.com`，而且已經複製到剪貼簿，直接貼給別人。

視窗關掉或電腦睡眠，網址就失效；每次重開網址都不一樣。帳號資料存在你的電腦裡。

**正式上線（雲端，例如 Render）**
- 開始指令：`npm start`（或 `node server.js`），不需要建置指令。
- 環境變數：`NODE_ENV=production`、`NO_OPEN=1`。
- 免費方案的檔案不會永久保存，帳號、收藏、申請追蹤在伺服器重啟後會消失。要保留的話，請掛永久磁碟（付費），並設定 `STORAGE_DIR` 指到磁碟路徑，例如 `/var/data`；或改用資料庫。
- `.gitignore` 已經排除使用者資料，上傳到 GitHub 時不會把帳號資料傳上去。
