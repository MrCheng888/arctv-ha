# Изменения

## 0.7.5.2
- Образ `node:24-alpine` задан в Dockerfile явно (Supervisor не передаёт `BUILD_FROM`).

## 0.7.5.1
- Сборка на базовом образе Home Assistant (Node.js из Alpine); название — ArcTV.

## 0.7.5
- Сервер ArcTV как дополнение Home Assistant (код тот же, что сервер 0.7.2 на NAS).
- Данные в папке `addon_configs` (видна через Samba, входит в резервные копии HA).
- Node.js 24.
