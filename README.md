# Wien

Локальная музыкальная среда на Strudel. Концепция проекта — в [proposal.md](proposal.md).

Клиент находится в [client/](client/README.md): Electron, React и TypeScript.
Все его зависимости, pnpm-скрипты, lockfile и конфигурация изолированы в этой папке.
Локальный AI-бэкенд находится в [server/](server/README.md): Rust, axum, OpenAPI,
единый контракт провайдеров и прямой dev-адаптер личного Codex.

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
- `just build-client` — `pnpm build` в `client`, результат в `client/out`.
- `just generate` — экспорт OpenAPI и генерация `server/http/*.http` для REST Client в VS Code.

Все pnpm-скрипты определены в [client/package.json](client/package.json).
Дополнительные команды, упаковка `.app` и работа с проектами описаны
в [инструкции клиента](client/README.md).
В редакторе Strudel доступен Hydra для визуального лайв-кодинга. См. [пример Hydra](examples/hydra.strudel)
и [инструкцию клиента](client/README.md#hydra).

В VS Code открывайте корень репозитория: задачи запускаются оттуда,
а форматирование при сохранении использует Biome из `client/` и rust-analyzer для Rust.
Default task **Wien: Run** (`⌘⇧B`) запускает обе части в соседних терминалах.
Для запуска сервера нужен работающий Docker с Compose и файл авторизации Codex.
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
явную ошибку `rag_not_ready`. `/v1/generate` остаётся обычным вызовом модели.

### Запуск

```sh
# Сохраните токен для последующих запусков: переменная окружения или корневой .env.
export STRUDEL_RAG_BEARER_TOKEN="$(openssl rand -hex 32)"
export OPENAI_API_KEY='your-key'
just run-server
# В соседнем терминале:
docker compose exec skill strudel-rag remote info
```

Вместо экспорта переменных можно скопировать `.env.example` в `.env` и заполнить его.
`server/config.toml` и файл авторизации Codex подключаются только для чтения.
Путь авторизации: `WIEN_CODEX_AUTH_FILE`, затем `$CODEX_HOME/auth.json`, затем
`$HOME/.codex/auth.json`; файл должен существовать до запуска контейнера.
После замены файла авторизации через Codex пересоздай контейнер:
`docker compose up -d --force-recreate server`.
Для запуска обоих сервисов в фоне: `docker compose up -d --build`.
Для остановки: `docker compose down` (данные RAG сохраняются).

Если `/v1/assist` возвращает `provider_unavailable`, проверьте доступ к модели
из контейнера: `docker compose exec server curl -I https://chatgpt.com/backend-api/codex/responses`.
HTTP 405 без авторизации означает, что соединение и TLS работают. `/ready`
проверяет только RAG и не обнаруживает эту проблему.

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

`ingest` требует доступа к upstream Strudel; `index` и поиск — к настроенному
embedding API. После успешного построения и перезапуска ожидаются
`ready: true` и `serving: true`. Для локального или другого OpenAI-совместимого
embedding API задайте `STRUDEL_RAG_EMBEDDING_BASE_URL` и
`STRUDEL_RAG_EMBEDDING_MODEL` до запуска; API-ключ не нужен, если его не требует
endpoint. Подробности — в
[Docker-инструкции skill](skill/README.md#docker-compose-from-the-repository-root).

Не коммитьте токены и API-ключи; `.env` уже исключён из Git.

## Проверки и CI

Все Rust-пакеты объединены корневым `Cargo.toml`: `server`, три пакета RAG,
`crates/rag-protocol` (общие protobuf-типы) и `crates/service-runtime`
(логирование и завершение процесса). Версии задаются в `workspace.dependencies`,
используется один `Cargo.lock` и каталог `target/`.

- `just test` проверяет клиент и весь Rust workspace.
- `just check-rust` запускает тот же pipeline, что CI: проверку инфраструктуры,
  fmt, Clippy, тесты, контракт OpenAPI, production release-сборку обоих сервисов
  и fixture ingest/index/search/eval без ключей и внешних API.
- `just build-server` собирает оба production-бинарника без fixture features.
- `just smoke-rag` проверяет retrieval на временном fixture-корпусе.

Корневой Dockerfile имеет targets `server` и `skill`, общий закреплённый компилятор
и runtime. Оба процесса работают под UID/GID 10001. Конфиги `server/config.toml`
и `skill/config.toml` монтируются read-only как `/app/config.toml`. Для своего
конфига задайте `WIEN_SERVER_CONFIG` или `STRUDEL_RAG_CONFIG`. Файлы обязательны;
неизвестные поля и ошибки TOML останавливают запуск. Секреты передаются через
окружение или read-only файл Codex, а не через TOML.

Оба сервиса пишут JSON-логи в stderr; уровень задаёт `RUST_LOG` (по умолчанию `info`).
Результаты CLI RAG остаются JSON в stdout. Docker healthchecks проверяют liveness:
`GET /health` для HTTP и `remote info` для gRPC. Для readiness используйте
`GET /ready` и `strudel-rag remote health`: проверяется готовность корпуса,
без вызовов модели или embeddings. Зелёный healthcheck не гарантирует доступность
внешних API.
