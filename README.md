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
just run-server
```

- `just run-client` — `pnpm dev` в `client`, Electron с hot reload.
- `just run-server` — Rust-сервер на `127.0.0.1:3001`, Swagger UI на `/docs/`.
- `just test` — линты, форматирование, типы и тесты клиента; rustfmt, Clippy и тесты сервера.
- `just build-client` — `pnpm build` в `client`, результат в `client/out`.
- `just build-server` — release-сборка в `server/target/release`.
- `just generate` — экспорт OpenAPI и генерация `server/http/*.http` для REST Client в VS Code.

Все pnpm-скрипты определены в [client/package.json](client/package.json).
Дополнительные команды, упаковка `.app` и работа с проектами описаны
в [инструкции клиента](client/README.md).

В VS Code открывайте корень репозитория: задачи запускаются оттуда,
а форматирование при сохранении использует Biome из `client/` и rust-analyzer для Rust.
Default task **Wien: Run** (`⌘⇧B`) запускает обе части в соседних терминалах.
Для сервера нужен stable Rust с компонентами rustfmt и clippy.

В редакторе `⌘,` (Windows/Linux: `Ctrl+,`) открывает ассистента у курсора:
введи запрос и нажми Enter. Shift+Enter добавляет строку, Esc закрывает поповер.
Ответ краткий, без истории чата; правки текущего файла применяются сразу и
отменяются через Cmd+Z после возврата в редактор. `⌘.` по-прежнему останавливает
текущий сниппет, `⌘⇧.` — все играющие табы, `⌘Enter` запускает или обновляет текущий. Для AI должны работать обе части.

## Docker Compose: Strudel RAG

Корневой [`compose.yaml`](compose.yaml) пока запускает только сервис `skill`.
Клиент и AI-бэкенд в Compose не включены.

### Запуск

```sh
# Сохраните токен для последующих запусков: переменная окружения или корневой .env.
export STRUDEL_RAG_BEARER_TOKEN="$(openssl rand -hex 32)"
export OPENAI_API_KEY='your-key'
docker compose up -d --build skill
docker compose exec skill strudel-rag remote info
```

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

GitHub Actions проверяет и собирает клиент, сервер и Rust workspace `skill/`
отдельными jobs на каждый push и pull request. Используются lockfile каждого
компонента. Для `skill/` запускаются rustfmt, Clippy и тесты со всеми features,
production release-сборка CLI и fixture-сборка с проверкой ingest/index/search/eval.
Тесты сервера и fixture-проверки skill не требуют личных токенов или запросов
к внешней модели. Workflow также можно запустить вручную из вкладки Actions.
