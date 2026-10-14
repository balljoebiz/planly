# Planly — self-hosted fork

**This repository is not my original work.** It is a personal, self-hosted copy of
[Planly](https://github.com/drkokorev/Planly) **v1.0.3**, with four local changes
(described below) and a Cloudflare Workers deployment that adds cross-device sync.

- **Live:** https://planly.balljoebiz.workers.dev
- **Original project:** https://github.com/drkokorev/Planly
- **Author / copyright holder:** Daniil Kokorev
- **Licence:** MIT — see [LICENSE](LICENSE), kept unmodified
- **Upstream release:** v1.0.3 (2026-10-09)

All credit for the application belongs to the original author. The MIT licence permits
copying, modification and redistribution **provided the copyright notice and the
permission notice are retained** — that is exactly what the `LICENSE` file is, so please
do not remove it.

---

## What this fork changes

| | Change | Files |
|---|---|---|
| 1 | The week starts on **Sunday** instead of Monday | `src/app.html` |
| 2 | Languages reduced to **English / 繁體中文 / 简体中文** | `src/i18n.js`, `src/app.html` |
| 3 | A **4-digit code lock** in front of the app (default `0000`) | `src/app.html` |
| 4 | **Cross-device sync** on Cloudflare Workers + KV | `worker/`, `wrangler.toml`, `tools/build.mjs` |
| 5 | Repeats get an **end date**, and edits/deletes can apply **from a chosen day onward** | `src/app.html` |
| 6 | **Restore points**, plus a guard against a bad device wiping your data | `src/app.html` |
| 7 | A **month view** with dot / summary density | `src/app.html` |

Everything below is written so you can port the same changes onto your own copy.

### 1. Week starts on Sunday

Upstream treats Monday as the first day of the week. Eight places in `src/app.html`
encode that; all of them become Sunday-based:

| Where | Before | After |
|---|---|---|
| `WD` weekday-name array | base date `new Date(2024,0,1)` (Monday) | `new Date(2024,0,7)` (Sunday) |
| `weekStartOf()` (was `mondayOf()`) | `(d.getDay()+6)%7` | `d.getDay()` |
| `seriesMatches()` | `(fromISO(iso).getDay()+6)%7` | `fromISO(iso).getDay()` |
| `repLabel()` weekday sets | `'0,1,2,3,4'` / `'5,6'` | `'1,2,3,4,5'` / `'0,6'` |
| `renderStrip()` | `mondayOf(S.date)` | `weekStartOf(S.date)` |
| `openUnload()` | `mondayOf(S.date)` ×2 | `weekStartOf(S.date)` ×2 |
| month grid first-cell offset | `(first.getDay()+6)%7` | `first.getDay()` |
| new weekly repeat default day | `(…getDay()+6)%7` | `…getDay()` |

**Careful:** the integers stored in a repeat rule's `days` array change meaning
(`0` used to be Monday, now it is Sunday). Existing weekly repeats on a live instance
will be reinterpreted — check them after upgrading.

If you would rather keep Monday, skip this change; the other three are independent.

### 2. Languages: English, Traditional and Simplified Chinese

Upstream ships six (`ru`, `en`, `es`, `de`, `zh`, `hi`). This fork keeps three:

```js
var LANGS=[['zh-TW','繁體中文','zh-TW'],['zh','简体中文','zh-CN'],['en','English','en-US']];
```

- **Russian has no dictionary upstream.** The keys *are* Russian strings and `tr()`
  falls back to the key, so removing `ru` only removes it from the picker — there is no
  dictionary to delete.
- The `es`, `de` and `hi` blocks are removed from `src/i18n.js`.
- A **`zh-TW` dictionary with 260 keys** is added (Taiwan vocabulary: 設定, 資料夾,
  剪貼簿, 備註, 封存, 時間軸…).

**`detectLang()` must be fixed**, otherwise `navigator.language.slice(0,2)` collapses
every Chinese locale to `zh` and Taiwanese users get Simplified:

```js
if(raw.indexOf('zh')===0){
  if(raw.indexOf('hant')>=0||/^zh-(tw|hk|mo)/.test(raw)) return 'zh-TW';
  return 'zh';
}
```

Two things worth knowing if you edit `src/i18n.js`:

- The dictionaries have **248 top-level keys**, not 262. The higher number counts the
  seven plural keys' sub-forms (`one`/`other`), which are separate lines.
- Every block's **last entry has no trailing comma**, and a block ends with ` },`
  (the final block with ` }`). JavaScript tolerates a trailing comma; JSON tooling
  does not — keep the convention if you generate the file.

### 3. Four-digit code lock

A full-screen PIN pad shown before the app boots. Default code `0000`, changeable in
Settings. **It is a screen lock, not encryption** — see the caveat below.

- The overlay `<div class="lock" id="lock">` sits *before* `<div class="app">` and is
  visible by default, so no app content flashes before JavaScript runs.
- The whole init sequence is wrapped in `boot()`, which is **not called until the code
  is accepted** — the data never reaches the DOM. This matters: an overlay alone would
  leave everything readable in the DOM behind it.
- The code is stored as a **SHA-256 hash** in `settings.pin` (`crypto.subtle`, with a
  weak fallback for non-secure contexts such as `file://`).
- Unlock is remembered in `sessionStorage`, so refreshing the page or switching language
  does not re-prompt; closing and reopening the app does.
- Because `checkPin()` reads `S.settings.pin`, `load()` had to move *before* the gate.
  It only reads `localStorage` and does not touch the DOM.

**Caveats.** A 4-digit code is 10,000 combinations and the planner's data stays
unencrypted in `localStorage`, so anyone with DevTools can read it and anyone can delete
the gate from the source. It stops someone picking up your unlocked device — nothing
more. If you need real protection, encrypt the document with a key derived from the code
(or move to server-side auth). Note also that *Wipe all data* resets the code to `0000`,
and that `pin` travels inside synced settings (see below).

### 4. Cross-device sync on Cloudflare Workers

Planly already has sync built in — it was simply unreachable on GitHub Pages, which
serves static files only. The client's `apiURL()` is a **same-origin relative path**:

```js
function apiURL(){ return new URL('api/sync',location.href).toString(); }
```

So the API must live on the same origin as the app. Two ways to do that:

**A. Cloudflare Workers + static assets (what this repo does)**

Upstream ships `functions/api/sync.js` for **Pages** Functions. Cloudflare's current
dashboard steers new projects to **Workers**, where `functions/` is not routed at all —
`/api/sync` just 404s. So `worker/index.js` implements the identical protocol and hands
everything else to the static assets:

```js
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/sync') return handleSync(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  }
};
```

`wrangler.toml` wires it up:

```toml
name = "planly"
main = "worker/index.js"
compatibility_date = "2026-01-01"

[assets]
directory = "./dist"
binding = "ASSETS"

[[kv_namespaces]]
binding = "PLANLY_SYNC"
id = "<your KV namespace id>"
```

**B. Cloudflare Pages (upstream's own path)**

If you would rather use Pages, keep `functions/api/sync.js` and create a Pages project
instead — it is picked up automatically. Build command `node tools/build.mjs`, output
directory `dist`.

**Either way the client needs no changes**, and the protocol is untouched:

```
GET  /api/sync?code=XXXX-XXXX-XXXX-XXXX            → { version, updatedAt, doc }
PUT  /api/sync?code=XXXX-XXXX-XXXX-XXXX {base,doc} → 200 { version }
                                                   | 409 { version, doc }  (server is ahead)
```

Conflicts are resolved by the client: on 409 it merges (per item, by `upd` timestamp,
with tombstones in `del`) and retries. The server never overwrites newer data.

**`tools/build.mjs`** is a Node-only replacement for `build.sh`, which needs bash,
`date` and `python3` — not ideal in a build container. It parses the HEAD/TAIL heredocs
out of `build.sh` so the two cannot drift, then writes `index.html` and `dist/`
(versioned `sw.js`, `version.txt`, `icons/`). Verified byte-identical to `build.sh`
output apart from the build stamp.

### 5. Repeat rules: an end date, and "from this day onward"

Upstream repeats run forever, can only be edited "for this one day" or "for all future
days", and stopping a repeat deletes the whole series including its past.

- `normalizeSeries()` gains `to` (empty string = forever) and `seriesMatches()` returns
  false past it — so `ensureOccurrences()` stops generating, and shortening an end date
  makes `regenSeries()` drop the instances that fall outside.
- The editor shows an end-date field (with a *no end date* button) whenever a repeat is on.
- `truncateSeries(sr, fromIso)` cuts a series from a date: non-completed instances from
  that day on are removed, completed ones are detached rather than deleted, and `sr.to`
  moves to the day before. The usual `save()` path then writes the tombstones, so the cut
  syncs to other devices.
- Setting a repeat back to *none* and saving now **truncates** from that day instead of
  deleting the series — the past is kept. Use the explicit buttons for the other outcomes.

### 6. Restore points — surviving a bad sync

The failure this guards against: one device (reinstalled, cleared, stale) pushes its
state, its tombstones win the merge, and every other device loses data with it.

- `histPush()` keeps the last **10 full-document snapshots** in `localStorage` under
  `planly.hist`, deduplicated by a content signature and throttled to one automatic
  snapshot per 2 minutes.
- Before applying a remote document, `wouldDelete()` counts how many of your items that
  document's tombstones would remove. At **4 or more** a snapshot is forced *before* the
  merge, and a toast tells you a restore point was saved.
- **Settings → Restore points** lists them (time, counts, and what caused it). Restoring
  bumps `upd` on every record — otherwise the server's tombstones would simply delete
  them again — and restores `del` from the snapshot. It also snapshots the current state
  first, so a restore is itself undoable.
- Clipboard import and *Wipe all data* take a snapshot first too.

### 7. Month view

A fifth tab, taking its cues from a separate month-grid notes app: one cell per day, a dot
per task coloured by priority, or — in summary density — the first two titles plus a `+n`
badge. Today is outlined, the selected day is tinted, days outside the month are dimmed,
and tapping a day jumps to the day view. The weekday header follows the Sunday-first
change from §1. Density is stored in `settings.monthDensity` (`dots` / `text`).

---

## Deploying your own copy

1. **Fork or clone** this repository into your own GitHub account.
2. **Create a free Cloudflare account** — no card required.
3. **Workers & Pages → Create → Workers → Connect to Git**, authorise GitHub and pick
   your repository. Keep the production branch `main`.
4. **Set the build command** — in the project's *Settings → Build*, set:
   - Build command: `node tools/build.mjs`
   - Deploy command: `npx wrangler deploy`

   This field defaults to empty. If you leave it empty, `dist/` is never produced and
   the deploy fails (or worse, silently serves the repository root — see the tip below).
5. **Create the KV namespace** — *Storage & databases → KV → Create namespace*. Copy the
   namespace id into `wrangler.toml` under `[[kv_namespaces]]`, binding `PLANLY_SYNC`.
   Commit and push; the binding survives because it lives in the file. Bindings added in
   the dashboard instead are overwritten by `wrangler.toml` on the next deploy.
6. **Push.** Every push to `main` now builds and deploys automatically.

> **Tip — how to tell whether the build really ran.** `version.txt` only exists inside
> `dist/`. If `https://<your-worker>/version.txt` returns 404 the build did not run,
> even though the site may look fine (the repository root happens to contain
> `index.html`, `manifest.json`, `sw.js` and `icons/` too). `GET /api/sync?code=…`
> returning `{"error":"no_kv_binding"}` means the Worker is routed but the KV binding
> is missing — that is the checkpoint between steps 4 and 5.

### Building locally

```bash
node tools/build.mjs      # writes index.html and dist/
python3 -m http.server 4321
```

No dependencies, no `npm install`.

### Optional: make sync invite-only

Set an `ALLOWED_CODES` secret (comma-separated codes) in the Worker's
*Settings → Variables and Secrets*. Unset means any well-formed code is accepted. Note
this restricts *which codes work* — it is not authentication. Anyone who knows a valid
code can read and write that document, and the document content is plain JSON.

### Picking up upstream releases

```bash
git remote add upstream https://github.com/drkokorev/Planly.git
git fetch upstream && git merge upstream/main
node tools/build.mjs
```

Expect conflicts in `src/app.html` around the eight week-start lines and in
`src/i18n.js` (the `LANGS` list and the removed dictionaries). Change 4 does not touch
upstream files, so it should merge cleanly.

---

## 正體中文

**本 repo 不是我的原創作品。** 這裡是 [Planly](https://github.com/drkokorev/Planly)
**v1.0.3** 的自架副本，加上了四項修改，並用 Cloudflare Workers 部署以便跨裝置同步。

- **線上站台：** https://planly.balljoebiz.workers.dev
- **原始專案：** https://github.com/drkokorev/Planly
- **作者／著作權人：** Daniil Kokorev
- **授權：** MIT，見 [LICENSE](LICENSE)（未經修改，請勿刪除）

應用程式的所有功勞歸原作者。MIT 授權允許複製、修改與再散布，條件是保留著作權聲明與
授權條款本身 —— 也就是這個 repo 裡的 `LICENSE`。

### 七項改動

| | 改動 | 檔案 |
|---|---|---|
| 1 | 一週改為從**週日**起算（原是週一） | `src/app.html` |
| 2 | 語言只留**英文／繁體中文／簡體中文** | `src/i18n.js`、`src/app.html` |
| 3 | 開站需輸入**4 位數密碼**（預設 `0000`） | `src/app.html` |
| 4 | 用 Cloudflare Workers + KV 做**跨裝置同步** | `worker/`、`wrangler.toml`、`tools/build.mjs` |
| 5 | 重複任務可設**結束日期**，修改／刪除可只套用**這天以後** | `src/app.html` |
| 6 | **還原點**，以及防止壞裝置把資料一拼移除的防護 | `src/app.html` |
| 7 | **月檢視**（圓點／摘要兩種密度） | `src/app.html` |

**1. 週日起算**：`src/app.html` 有 8 處以週一為基準，全部改成 `getDay()`（原本是
`(getDay()+6)%7`），`mondayOf()` 更名為 `weekStartOf()`。**注意**：重複任務存在
`days` 陣列裡的整數意義會改變（`0` 從週一變成週日），既有資料請重新確認。

**2. 語言**：`LANGS` 只留三種；刪掉 `es`／`de`／`hi` 字典；新增 **zh-TW 字典 260 條**
（台灣用語）。**俄文本來就沒有字典** —— 鍵本身就是俄文、`tr()` 找不到翻譯就回傳鍵，
所以移除的只是選單項目。`detectLang()` 必須修，否則繁中與簡中都收斂成 `zh`，
台灣使用者會拿到簡中。編輯字典時注意兩個慣例：**頂層鍵是 248 個**（262 是把複數子形式
算進去的字面行數），而且**每個區塊最後一條不帶逗號**。

**3. 密碼鎖**：遮罩放在 `<div class="app">` 之前、預設可見（不會先閃出內容）；
整段初始化包成 `boot()`，**未解鎖前完全不執行**，所以資料不會進到 DOM。
密碼以 **SHA-256 雜湊**存在 `settings.pin`；解鎖狀態記在 `sessionStorage`，
重新整理或切換語言不會重問，關掉 app 再開才會。**這只是螢幕鎖不是加密** ——
資料在 `localStorage` 仍是明文，擋不住開發者工具。「清除所有資料」會把密碼重設為 `0000`。

**4. 跨裝置同步**：客戶端的 `apiURL()` 是**同源相對路徑**，所以 API 必須跟 app 同一個
origin。上游為 Cloudflare **Pages** 準備了 `functions/api/sync.js`，但新版 dashboard
把新專案導向 **Worker**（`functions/` 不會被路由，`/api/sync` 直接 404），所以本 repo
改用 `worker/index.js` 實作**完全相同**的協定，其餘交給靜態資產。`wrangler.toml` 指
`assets` 到 `dist/` 並綁定 KV。衝突處理仍由客戶端負責：收到 409 就先逐項合併（比
`upd` 時間戳、用 `del` 墓碑）再重試，伺服器端永不覆蓋較新的資料。

**5. 重複任務的結束日期與「這天以後」**：`normalizeSeries()` 新增 `to`（空＝永久），
`seriesMatches()` 超過就不再符合，所以 `ensureOccurrences()` 不再產生、`regenSeries()`
也會把超出新結束日的實例收掉。編輯器在開啟重複時顯示結束日期欄位（附「無結束日期」按鈕）。
`truncateSeries(sr, fromIso)` 從某天截斷：之後未完成的實例移除、已完成的只脫離系列不刪除，
並把 `to` 移到前一天；刪除由一般的 `save()` 產生墓碑，所以會同步到其他裝置。
把重複改成「無」再儲存，現在是**截斷**而不是刪掉整個系列，過去會保留。

**6. 還原點（防止壞同步）**：要防的是「一台裝置狀態錯誤 → 它的墓碑在合併中勝出 →
其他裝置一起掉資料」。`histPush()` 在 `localStorage`（`planly.hist`）保留最近 **10 份**
完整快照，以內容簽章去重，自動快照每 2 分鐘最多一次。套用遠端文件前，`wouldDelete()`
會先算「這份文件的墓碑會刪掉我幾筆」，達到 **4 筆**就在**合併前強制存快照**並提示。
設定裡的**還原點**會列出時間、筆數與成因；還原時會把所有項目的 `upd` 提高
（否則伺服器的墓碑會再把它們刪一次）並還原 `del`，而且**還原本身也會先存一份**，
所以可以再還原回去。匯入與「清除所有資料」也一樣會先存。

**7. 月檢視**：第五個分頁。每天一格；圓點密度時每筆任務一個點（依優先級上色），
摘要密度時顯示前兩筆標題與 `+n` 標記。今天加框、選取日加底色、非本月淡化，
點日期跳到日檢視。星期列沿用第 1 項的週日起算。密度記在 `settings.monthDensity`。

### 自己部署一份

1. Fork 這個 repo
2. 註冊免費 Cloudflare 帳號（不需要信用卡）
3. **Workers & Pages → 建立 → 連線至 Git**，選你的 repo，分支 `main`
4. 到專案的 **設定 → 建置**，把**建置命令**設成 `node tools/build.mjs`
   （預設是空的；留空的話 `dist/` 不會被產生，部署會失敗）
5. **儲存空間和資料庫 → KV → 建立命名空間**，把 namespace id 填進 `wrangler.toml`
   的 `[[kv_namespaces]]`（繫結名 `PLANLY_SYNC`）並 push
6. 之後每次 push 都會自動建置部署

> **判斷建置有沒有真的跑**：`/version.txt` 只存在於 `dist/`。若它回 404，就是建置沒跑
> —— 即使網站看起來正常（repo 根目錄剛好也有 `index.html`、`manifest.json`、`sw.js`、
> `icons/`）。若 `/api/sync` 回 `{"error":"no_kv_binding"}`，代表 Worker 已生效、只差 KV 繫結。

### 本機建置

```bash
node tools/build.mjs      # 產生 index.html 與 dist/
```

不需要任何依賴，也不用 `npm install`（原版 `build.sh` 需要 bash、`date`、`python3`）。

### 升級到上游新版

```bash
git fetch upstream && git merge upstream/main
node tools/build.mjs
```

`src/app.html` 的 8 處週一起算、以及 `src/i18n.js` 的語言清單與字典會有衝突；
第 4 項沒有動到上游檔案，應該能乾淨合併。
