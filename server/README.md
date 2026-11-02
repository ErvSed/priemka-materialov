# ПРИЁМКА — сервер общей базы

Небольшой сервис без внешних Python-зависимостей. Хранит один общий реестр в SQLite, объединяет записи по постоянному ID и **никогда не удаляет** их. Предназначен для работы за Nginx по HTTPS.

## Как это устроено

- `POST /sync` с заголовком `Authorization: Bearer <код>` и JSON `{"records": [...]}`.
- Сервер объединяет присланные записи с уже сохранёнными:
  - разные ID добавляются;
  - для одинакового ID побеждает более поздний `updatedAt`;
  - истории версий объединяются и дедуплицируются;
  - отсутствие записи в запросе не удаляет её из базы.
- Ответ: `{"ok": true, "records": [...], "count": N, "serverTime": "..."}`.
- `GET /health` — проверка сервиса без данных.
- `OPTIONS` — CORS preflight для сайта.

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
```

Тест поднимает временный сервер, проверяет CORS, авторизацию, объединение, конфликт версий и отсутствие удаления.

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
