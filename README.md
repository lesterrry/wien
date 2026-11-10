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

GitHub Actions проверяет и собирает клиент и сервер отдельными jobs на каждый push
и pull request. Используются оба lockfile; серверные тесты не требуют личных токенов
или запросов к модели. Workflow также можно запустить вручную из вкладки Actions.
