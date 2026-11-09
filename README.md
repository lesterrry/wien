# Wien

Локальная музыкальная среда на Strudel. Концепция проекта — в [proposal.md](proposal.md).

Клиент находится в [client/](client/README.md): Electron, React и TypeScript.
Все его зависимости, pnpm-скрипты, lockfile и конфигурация изолированы в этой папке.
Будущий AI harness будет отдельной частью в `server/`.

## Запуск из корня

```sh
pnpm --dir client install
just run
```

- `just run` — `pnpm dev` в `client`, Electron с hot reload.
- `just test` — линты, проверка форматирования, TypeScript и тесты клиента.
- `just build` — `pnpm build` в `client`, результат в `client/out`.

Все команды определены в [client/package.json](client/package.json).
Дополнительные команды, упаковка `.app` и работа с проектами описаны
в [инструкции клиента](client/README.md).

В VS Code открывайте корень репозитория: задачи запускаются оттуда,
а форматирование при сохранении использует Biome из `client/`.

GitHub Actions запускает `pnpm test` и `pnpm build` в `client/` на каждый push
и pull request. Зависимости устанавливаются по lockfile; workflow также можно
запустить вручную из вкладки Actions.
