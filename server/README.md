# ПРИЁМКА — сервер общей базы

Небольшой сервис без внешних Python-зависимостей. Хранит один общий реестр в SQLite, объединяет записи по постоянному ID и **никогда не удаляет** их. Предназначен для работы за Nginx по HTTPS.

## Центральный портал

Сервис одновременно обслуживает старый `/sync` и новый центральный портал:

- `POST /login` с JSON `{"code": "..."}` — вход по коду; возвращает `sessionToken` и устанавливает cookie;
- `POST /logout` — завершает сессию;
- `GET /session` — текущий аккаунт;
- `GET /records` — все материалы из общей базы;
- `POST /records` с JSON `{"records": [...]}` — объединить изменения; пользователь не может менять архив, это проверяется сервером;
- `GET /accounts` — список аккаунтов (только администратор);
- `POST /accounts` с JSON `{"name": "..."}` — создать сотрудника и получить одноразовый код (только администратор);
- `POST /accounts/{id}/reset` — выпустить новый код и завершить сессии сотрудника (только администратор);
- `POST /accounts/{id}/revoke` — отозвать доступ (только администратор).

Новые эндпоинты принимают сессию двумя способами: `Authorization: Bearer <sessionToken>` (нужно для GitHub Pages) или HttpOnly-cookie (для серверного зеркала). CORS разрешает origin GitHub Pages и заголовок `Authorization`. Токены входа хранятся только как SHA-256-хэши.

Аккаунты и сессии хранятся в таблицах `accounts` и `sessions`. Коды входа хранятся только как SHA-256-хэши. Сессионная cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, срок 30 дней. Начальный администратор создаётся скриптом `server/create_admin.py`; его код выводится один раз.

## Как это устроено

- `POST /sync` с заголовком `Authorization: Bearer <код>` и JSON `{"records": [...]}`.
- Сервер объединяет присланные записи с уже сохранёнными:
  - разные ID добавляются;
  - для одинакового ID побеждает более поздний `updatedAt`;
  - истории версий объединяются и дедуплицируются;
  - отсутствие записи в запросе не удаляет её из базы.
- Ответ: `{"ok": true, "records": [...], "count": N, "role": "admin|user", "serverTime": "..."}`.
- `GET /health` — проверка сервиса без данных.
- `OPTIONS` — CORS preflight для сайта.

### Пользователи

Администратор — это владелец сервера с кодом из `PRIEMKA_TOKEN_SHA256`/`PRIEMKA_TOKEN`. Он может создавать пользователей:

- `GET /users` — список пользователей (только администратор);
- `POST /users` с JSON `{"username": "Прораб Иван"}` — создать пользователя; одноразово возвращает `user.token` (только администратор);
- `POST /users/{id}/revoke` — отозвать доступ (только администратор).

Токены пользователей хранятся в SQLite только в виде SHA-256-хэшей. Пользовательский токен даёт доступ к `/sync`, но не к управлению пользователями. При отзыве токен сразу перестаёт работать.

Роль `user` — это ограничение интерфейса и административных API, а не отдельная криптографическая граница: код пользователя позволяет синхронизировать общую базу. Не выдавайте коды недоверенным людям.

Файл базы по умолчанию: `/opt/priemka/data/priemka.db`.

## Переменные окружения

```dotenv
PRIEMKA_DB=/opt/priemka/data/priemka.db
PRIEMKA_TOKEN_SHA256=<sha256-хэш-кода-в-hex>
PRIEMKA_ALLOWED_ORIGINS=https://ervsed.github.io
PRIEMKA_HOST=127.0.0.1
PRIEMKA_PORT=8012
```

Для локальной отладки можно задать `PRIEMKA_TOKEN` вместо хэша. В production используйте только `PRIEMKA_TOKEN_SHA256`, а сам код храните у владельца реестра.

Хэш кода:

```bash
printf '%s' 'ВАШ_ДЛИННЫЙ_КОД' | sha256sum
```

## Локальные тесты

```bash
python3 server/test_sync.py
python3 server/test_portal.py
```

Тест поднимает временный сервер, проверяет CORS, авторизацию, объединение, конфликт версий, отсутствие удаления, создание пользователя, его sync-доступ и отзыв.

## Установка на Ubuntu

```bash
apt-get update
apt-get install -y python3 nginx
useradd --system --home /opt/priemka --shell /usr/sbin/nologin priemka

install -d -o priemka -g priemka -m 0700 /opt/priemka/data
install -d -o priemka -g priemka -m 0700 /opt/priemka/backups
install -o root -g root -m 0755 server/priemka_sync.py /opt/priemka/priemka_sync.py
install -o root -g root -m 0755 server/backup.py /opt/priemka/backup.py
install -o root -g priemka -m 0640 server/priemka.env.example /opt/priemka/priemka.env
# отредактируйте /opt/priemka/priemka.env

install -o root -g root -m 0644 server/priemka-sync.service /etc/systemd/system/priemka-sync.service
systemctl daemon-reload
systemctl enable --now priemka-sync
```

Проверка:

```bash
curl http://127.0.0.1:8012/health
```

Nginx: подключите `server/priemka-rate.conf` в `http`-контекст, а `server/nginx-priemka-api.conf` — внутрь существующего HTTPS `server`-блока:

```nginx
include /etc/nginx/snippets/priemka-api.conf;
```

Затем `nginx -t && systemctl reload nginx`.

## Резервные копии

```bash
install -o root -g root -m 0644 server/priemka-backup.cron /etc/cron.d/priemka-backup
```

Скрипт делает согласованный снимок SQLite, сжимает его и хранит 14 дней. Проверить вручную:

```bash
sudo -u priemka /usr/bin/python3 /opt/priemka/backup.py
```

## Ограничения

- Код доступа — общий секрет. Он передаётся только по HTTPS и хранится у пользователя.
- В базе данные хранятся в открытом виде внутри SQLite; доступ к серверу и файлу БД должен быть ограничен. Локальные реестры на устройствах при этом остаются зашифрованными.
- Сервис рассчитан на один общий реестр. Для нескольких независимых организаций нужно добавить отдельные пространства и ключи.
- CORS ограничен доменом сайта; сам по себе CORS не является авторизацией — обязателен Bearer-код.
- Пароль SSH и доступ к серверу не входят в приложение.
