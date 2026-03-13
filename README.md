# Threads Auto-Poster — Airtable + Threads API + Anthropic + Telegram Alerts

Сервіс **тільки для Threads-постингу (1 акаунт)**:
- бере “сіди” з RSS/Atom фідів у Airtable (`Threads Donors`)
- генерує треди (EN/UA) через Anthropic (`claude-sonnet-4-6`)
- постить у Threads через **офіційний Threads API**
- пише логи в Airtable (`Run Logs`) і шле **тільки CRITICAL** алерти в Telegram (у forum topic)

## Як це працює (1 цикл = “cron run”)

1) **INGEST**
   - читаємо `Threads Donors`, де `Status=Active` і `Feed URL` не порожній
   - беремо **найновіші N постів** з кожного донора (`INGEST_MAX_ITEMS_PER_DONOR`, дефолт `1`)
   - створюємо записи в `Posts` зі статусом `Seeded` (дедуп по `Seed URL` + `Seed Hash`)

2) **GENERATE**
   - для `Seeded` генеруємо `Thread Parts JSON` + `Thread Preview`, ставимо `Post Status=Generated`
   - формат підбирається динамічно:
     - `prompt_thread` — ланцюжок промптів (довший)
     - `tool_list` — список інструментів
     - `alternatives_list` — paid→free свопи
     - `news_insight` — новина → інсайт → що робити

3) **PUBLISH (immediate)**
   - якщо `AUTOPUBLISH_ENABLED=true` — беремо `Generated` і одразу постимо:
     - root → replies → CTA в останньому reply
   - якщо виконання перервалось (timeout/краш), публікація **resume-иться**:
     - під час публікації ми записуємо прогрес у `Posts.Error` як `PROGRESS:{...}`
     - наступний запуск продовжить з того місця, де зупинилось
   - для `prompt_thread` є fail-safe: URL CTA додається також у root (щоб лінк не пропадав, навіть якщо тред обірвався)

## Telegram алерти (що саме прилітає)

Надсилаємо **лише CRITICAL**:
- `CRITICAL PUBLISH FAILED` — publish не вдався після 3 спроб для конкретного `Posts` record
- `CRITICAL AUTH` — 401/403 від Threads API (токен/доступ)
- `CRITICAL HEALTH` — “queue stuck” (немає `Published` > 24 год при непорожній черзі або є прострочені `Scheduled` > 2 год)

Все інше пишеться в Airtable `Run Logs`, **без Telegram-спаму**.

## Запуск локально

1) Встановити залежності: `npm.cmd i`
2) Створити `.env` з `.env.example` і заповнити ключі
3) Запуск 1 циклу (як cron): `npm.cmd run once`
4) Режим сервісу (локально): `npm.cmd run dev`
   - одразу запускає 1 цикл
   - далі запускає цикл кожні `INTERVAL_HOURS` годин **і тільки у вікні** `WINDOW_START_HOUR..WINDOW_END_HOUR` у `TIMEZONE`

## Deploy на Vercel + “cron” кожні 2 години (Hobby)

Vercel Hobby дозволяє лише daily cron jobs. Тому схема така:
- деплоїмо на Vercel endpoint `GET /api/cron`
- запускаємо **GitHub Actions schedule** (`.github/workflows/cron.yml`), який кожні 2 години викликає `/api/cron`
- захищаємо endpoint секретом `CRON_SECRET` (GitHub Actions відправляє header `x-cron-secret`)

### Env на Vercel

У Vercel → Project → Settings → Environment Variables додай значення з `.env.example` (без коміту секретів).

## Тюнінг параметрів (важливе)

- `THREAD_PART_MAX_CHARS` — ліміт символів на 1 частину (Threads: 500).
- `PARTS_TARGET_MIN/MAX` — цільова довжина для “не-спискових” форматів (prompt/news). Для `tool_list`/`alternatives_list` завжди робимо **2 частини**: (1) root зі списком, (2) CTA.
- `THREADS_INTER_PART_DELAY_MS` — пауза перед кожним reply (менше = швидше, але може частіше ловити propagation errors).
- `THREADS_REPLY_RETRY_*` — ретраї publish, якщо Graph API ще “не бачить” щойно створений контейнер/пост.
- `PROMPT_THREAD_INTER_PART_DELAY_MS` / `PROMPT_THREAD_REPLY_RETRY_DELAY_MS` — окремі (швидші) затримки саме для `prompt_thread`, щоб не впиратися в serverless timeout.

## CTA

CTA задається через env (`CTA_URL`, `CTA_TEXT_EN`, `CTA_TEXT_UA`) і зберігається в Airtable на етапі ingest.
