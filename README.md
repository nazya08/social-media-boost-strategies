# Threads Auto-Poster — Airtable + Threads API + Anthropic + Telegram Alerts

Сервіс **тільки для Threads-постингу (1 акаунт)**:
- бере “сіди” з RSS/Atom фідів у Airtable (`Threads Donors`)
- генерує тред (EN/UA) через Anthropic (`claude-sonnet-4-6`)
- постить у Threads через **офіційний Threads API**
- пише логи у Airtable (`Run Logs`) і шле **лише CRITICAL** алерти в Telegram (в forum topic)

## Як це працює (1 цикл = “cron run”)

1) **INGEST**: читаємо `Threads Donors`, де `Status=Active` і `Feed URL` не порожній.  
Беремо **найновіші N постів** з кожного донора (`INGEST_MAX_ITEMS_PER_DONOR`, за замовчуванням `1`) і створюємо записи в `Posts` зі статусом `Seeded`. Дедуп — по `Seed URL` і `Seed Hash`.

2) **GENERATE**: для нових `Seeded` постів генеруємо `Thread Parts JSON` + `Thread Preview` і ставимо статус `Generated`.

3) **PUBLISH (immediate)**: якщо `AUTOPUBLISH_ENABLED=true`, беремо `Generated` і одразу постимо в Threads:
- root пост → replies → останнім реплаєм CTA
- затримки/ретраї для “пропагації” (`THREADS_*` у `.env.example`)
- при успіху: `Post Status=Published`, зберігаємо `Threads Root ID` і `Threads Root URL`
- при фейлі: пишемо `Error`, інкрементимо `Attempt Count`; після 3-ї спроби — `Post Status=Failed` + CRITICAL алерт у Telegram

За один запуск публікуємо не більше `PUBLISH_MAX_PER_RUN` постів (за замовчуванням `1`).

Важливо: Threads має ліміт **500 символів** на пост. Якщо `tool_list` не влізає — генератор автоматично робить **менше пунктів** (7–9) замість того, щоб різати пункт посередині.

## Що таке `Feed URL`?

Це **посилання на RSS/Atom фід** донора (не Threads-профіль).  
Зазвичай це URL від RSS-бріджа/провайдера, який “перетворює” Threads/X/сайт на RSS.

## Медіа (картинки/відео)

- Якщо RSS містить `enclosure`, `media:content` або `<img ...>` у HTML-контенті — ми збережемо `Media URL`/`Media Type` в Airtable.
- Постинг медіа **вимкнений за замовчуванням**. Увімкнути: `POST_MEDIA_ENABLED=true` (медіа підставляється **лише в root**).
- Якщо медіа-URL недоступний/непублічний — Threads API може фейлити; тоді ми робимо fallback на text-only і продовжуємо.

## Формати контенту (адаптація під тип seed-поста)

Модель повертає один із форматів:
- `prompt_thread` — ланцюжок промптів
- `tool_list` — список інструментів (форсуємо **2 частини**: root з листом + reply з CTA)
- `alternatives_list` — paid→free свопи (також **2 частини**)
- `news_insight` — “новина → інсайт → що робити”

## Які помилки приходять в Telegram?

**Тільки CRITICAL**:
- `CRITICAL PUBLISH FAILED` — publish не вдався після 3-ї спроби для конкретного `Posts` record
- `CRITICAL AUTH` — 401/403 від Threads API (токен/доступ)
- `CRITICAL HEALTH` — “queue stuck” (немає `Published` > 24 год при непорожній черзі або прострочені `Scheduled` > 2 год)

Все інше пишеться в Airtable `Run Logs`, але **без Telegram-спаму**.

## Запуск (команди)

1) Встановити залежності: `npm.cmd i`
2) Створити `.env` з `.env.example` і заповнити ключі
3) Запуск одного циклу (як cron): `npm.cmd run once`
4) Режим сервісу (локально): `npm.cmd run dev`
   - одразу запускає 1 цикл
   - далі запускає цикл кожні `INTERVAL_HOURS` годин **і тільки в вікні** `WINDOW_START_HOUR..WINDOW_END_HOUR` у `TIMEZONE`

## Deploy на Vercel + Cron

Vercel Hobby дозволяє лише **daily** cron jobs. Для запуску кожні 2 години:
- деплоїмо сервіс на Vercel (endpoint `GET https://<domain>/api/cron`)
- запускаємо **GitHub Actions schedule** (`.github/workflows/cron.yml`), який кожні 2 години викликає `/api/cron`
- захищаємо endpoint через `CRON_SECRET` (header `x-cron-secret`)

## Тумблери безпеки

- Зупинити автопостинг: `AUTOPUBLISH_ENABLED=false`
- Вимкнути Telegram-алерти: `TELEGRAM_ALERTS_ENABLED=false`

## CTA

CTA задається через env (`CTA_URL`, `CTA_TEXT_EN`, `CTA_TEXT_UA`) і зберігається в Airtable на етапі ingest. За потреби можна примусово перекинути CTA URL для публікації через `CTA_URL` (старі t.me лінки в останній частині будуть замінені).
