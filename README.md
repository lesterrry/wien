# Wien

Локальная музыкальная среда на Strudel. Концепция проекта — в [proposal.md](proposal.md).

Клиент находится в [client/](client/README.md): Electron, React и TypeScript.
Все его зависимости, pnpm-скрипты, lockfile и конфигурация изолированы в этой папке.
Реестр примеров — [examples/](examples/README.md): каждая подпапка является проектом,
а `examples/default/` задаёт содержимое первого и каждого нового проекта.
Локальный AI-бэкенд находится в [server/](server/README.md): Rust, axum, OpenAPI,
AI Tunnel для генерации и embeddings; Codex сохранён как отдельный dev-адаптер.

## Запуск из корня

```sh
pnpm --dir client install
just run-client
# В соседнем терминале:
# Один раз: скопируй .env.example в .env и заполни STRUDEL_RAG_BEARER_TOKEN.
just run-server
```

- `just run-client` — `pnpm dev` в `client`, Electron с hot reload.
- `just run-server` — сборка и запуск `server` + `skill` через Docker Compose,
  общие логи в терминале; Ctrl+C останавливает оба сервиса.
  HTTP-сервер на `127.0.0.1:3001`, Swagger UI на `/docs/`.
- `just test` — линты, форматирование, типы и тесты клиента; rustfmt, Clippy и тесты сервера.
- `just build-client` — сборка приложения в `client/release`; в конце выводится полный путь к `.app` на macOS или каталогу приложения на Windows/Linux.
- `just generate` — экспорт OpenAPI и генерация `server/http/*.http` для REST Client в VS Code.

Все pnpm-скрипты определены в [client/package.json](client/package.json).
Дополнительные команды, упаковка `.app` и работа с проектами описаны
в [инструкции клиента](client/README.md).

Веб-версия: `just run-web` (http://127.0.0.1:5174), сборка — `just build-web`.
Проекты хранятся в браузере, Versions в вебе отключены; аккаунт использует HttpOnly cookie.
Подробнее — [client/README.md](client/README.md#веб-версия).

Адрес бэкенда для Electron-клиента задаётся в `client/config.yaml` (`backendUrl`).
По умолчанию это `http://127.0.0.1:3001`. Запуск с VPS без локального сервера:
`WIEN_BACKEND_URL=https://wien.aydar.media just run-client`.
Assist требует входа в аккаунт и доступных запросов; новый аккаунт получает 10 бесплатно.

В VS Code открывайте корень репозитория: задачи запускаются оттуда,
а форматирование при сохранении использует Biome из `client/` и rust-analyzer для Rust.
Default task **Wien: Run** (`⌘⇧B`) запускает обе части в соседних терминалах.
Для запуска сервера нужен работающий Docker с Compose и `AITUNNEL_KEY` в `.env`.
Rust закреплён в `rust-toolchain.toml`; `rustup show` устанавливает нужную версию,
rustfmt и clippy. Все команды выполняются из корня репозитория.

В редакторе `⌘,` (Windows/Linux: `Ctrl+,`) открывает ассистента у курсора:
введи запрос и нажми Enter. Shift+Enter добавляет строку, Esc закрывает поповер.
Ответ краткий, без истории чата; правки текущего файла применяются сразу и
отменяются через Cmd+Z после возврата в редактор. `⌘.` по-прежнему останавливает
текущий сниппет, `⌘⇧.` — все играющие табы, `⌘Enter` запускает или обновляет текущий. Для AI должны работать обе части.

## Docker Compose: сервер и Strudel RAG

Корневой [`compose.yaml`](compose.yaml) запускает AI-бэкенд `server` и RAG `skill`.
Electron-клиент работает на хосте. Сервер стартует после успешного healthcheck RAG;
внутренний адрес RAG — `http://skill:50051`. `/v1/assist` проверяет готовность корпуса,
передаёт модели музыкальный скилл и выполняет её вызовы поиска, чтения документов
и жанровых гайдов. Для ассистента нужен построенный индекс; пустой корпус даёт
явную ошибку `rag_not_ready`.

### Запуск

```sh
# Сохраните токен для последующих запусков: переменная окружения или корневой .env.
export STRUDEL_RAG_BEARER_TOKEN="$(openssl rand -hex 32)"
export AITUNNEL_KEY='your-key'
just run-server
# В соседнем терминале:
docker compose exec skill strudel-rag remote info
```

Вместо экспорта переменных можно скопировать `.env.example` в `.env` и заполнить его.
`AITUNNEL_KEY` используется обоими сервисами: моделью через
`https://api.aitunnel.ru/v1/responses` и RAG через `/v1/embeddings`.
В `server/config.toml` выбран `provider = "aitunnel"`, в секции `[generation]` — модель `gpt-6-luna`
с `reasoning_effort = "low"` для ассистента. Embeddings — `text-embedding-3-small`.
При смене ключа пересоздай оба контейнера: `docker compose up -d --force-recreate`.
`just run-server` всегда добавляет `compose.codex.yaml` и монтирует локальный
файл авторизации Codex read-only, независимо от `provider`. Файл должен существовать.
Адаптер выбирается только в `server/config.toml`; см. инструкцию сервера.
Для запуска обоих сервисов в фоне: `docker compose up -d --build`.
Для остановки: `docker compose down` (данные RAG сохраняются).

`/ready` проверяет RAG без платных вызовов; доступность AI Tunnel и баланс
проверяются реальным запросом ассистенту. На VPS `/v1/assist` доступен с сессией и
положительным остатком. Nginx проксирует все маршруты бэкенда, включая аккаунты,
`/health`, `/ready` и Swagger.

Если корпоративный DNS возвращает только IPv6, задайте `WIEN_DOCKER_IPV6=true`
в `.env`. IPv6 должен работать и в Docker VM. Для добавления корпоративного CA
задайте `COMPOSE_FILE=compose.yaml:compose.ca.yaml` и
`WIEN_CA_BUNDLE=./.local/ca-bundle.pem`: это PEM bundle публичных доверенных CA
(обычные корневые сертификаты плюс корпоративный CA, без приватных ключей).
Оба сервиса подключат его read-only; проверка TLS остаётся включённой.
Сертификат экспортируйте из уже доверенного хранилища вашей ОС, а не из
непроверенного ответа сервера. `*.pem` исключены из Git и Docker build context.
При изменении IPv6 нужно пересоздать сеть: `docker compose down`, затем
`just run-server`. Не добавляйте `--volumes`: индекс должен сохраниться.

gRPC доступен на `127.0.0.1:50051`; порт хоста можно изменить через
`STRUDEL_RAG_PORT`. Данные сохраняются в named volume `skill-data`.
Первый запуск без индекса допустим: `remote info` покажет `ready: false`.
Healthcheck проверяет доступность авторизованного gRPC, а не готовность поиска.

### Заполнение индекса

После первого запуска импортируйте источники и постройте индекс:

```sh
docker compose run --rm skill ingest
docker compose run --rm skill index
# Сервер открывает индекс при старте — перезапустите после построения.
docker compose restart skill
docker compose exec skill strudel-rag remote info
docker compose exec skill strudel-rag remote health
```

`ingest` требует доступа к upstream Strudel; `index` и поиск — к AI Tunnel.
После построения и перезапуска ожидаются `ready: true` и `serving: true`.
`STRUDEL_RAG_EMBEDDING_MODEL` меняет модель embeddings; смена модели требует
перестроить индекс. Подробности — в
[Docker-инструкции skill](skill/README.md#docker-compose-from-the-repository-root).

Не коммитьте токены и API-ключи; `.env` уже исключён из Git.

## Проверки и CI

Все Rust-пакеты объединены корневым `Cargo.toml`: `server`, три пакета RAG,
`crates/rag-protocol` (общие protobuf-типы) и `crates/service-runtime`
(логирование и завершение процесса). Версии задаются в `workspace.dependencies`,
используется один `Cargo.lock` и каталог `target/`.

- `just test` проверяет клиент, Rust-форматирование, Clippy, тесты всего workspace
  и актуальность сгенерированного HTTP-контракта.
- `just build-server` собирает оба production-бинарника.
- CI выполняет те же проверки и отдельно собирает клиент и production-бинарники.

Корневой Dockerfile имеет targets `server` и `skill`, общий закреплённый компилятор
и runtime. Оба процесса работают под UID/GID 10001. Конфиги `server/config.toml`
и `skill/config.toml` монтируются read-only как `/app/config.toml`. Для своего
конфига задайте `WIEN_SERVER_CONFIG` или `STRUDEL_RAG_CONFIG`. Файлы обязательны;
неизвестные поля и ошибки TOML останавливают запуск. Секреты передаются через
окружение; опциональный адаптер Codex использует read-only файл, а не TOML.

Оба сервиса пишут JSON-логи в stderr; уровень задаёт `RUST_LOG` (по умолчанию `info`).
Результаты CLI RAG остаются JSON в stdout. Docker healthchecks проверяют liveness:
`GET /health` для HTTP и `remote info` для gRPC. Для readiness используйте
`GET /ready` и `strudel-rag remote health`: проверяется готовность корпуса,
без вызовов модели или embeddings. Зелёный healthcheck не гарантирует доступность
внешних API.

## Ручной релиз приложения

GitHub Actions → **Release app** → **Run workflow**. Собирает macOS (Apple Silicon
и Intel), Windows x64 и Linux x64, затем публикует GitHub Release с датой и временем
по Москве и установщиками. Подробнее — [client/README.md](client/README.md#релиз-приложения).

## Ручной релиз бэкенда

Обычный CI запускается для pull request, push в `main` и вручную. Push в рабочую
ветку без PR не запускает проверки. Rust-зависимости и `httpgenerator` кешируются;
release-бинарники собираются в релизном workflow. Названия обязательных проверок
остаются прежними.

GitHub Actions → **Release production** → **Run workflow**. Сборка выполняется
на GitHub, готовые образы передаются на VPS по отдельному SSH-ключу.
Пуши сами по себе деплой не запускают. Подробности — в [deploy/README.md](deploy/README.md).

## Аккаунт

Пункт **Sign in** в верхнем меню проекта открывает вход. Регистрация доступна только
в веб-версии и требует Cloudflare Turnstile; в приложении есть ссылка на сайт.
Нужны только username (3–32 символа `a-z`, `0-9`, `_`) и пароль (12–128 символов).
Профиль показывает username и дату регистрации; там же можно сменить пароль и выйти.
Почты и восстановления забытого пароля пока нет. Меню показывает тир и остаток
запросов assist. `free` получает 10 запросов однократно; ошибки и отмены до завершения
не списываются. PLUS / PRO / ULTRA пока только витрина, без оплаты и апгрейда.
Локальный `just run-server` запускает PostgreSQL вместе с бэком и RAG;
данные аккаунтов хранятся в постоянном томе. Не удаляй тома Compose при обновлениях.
