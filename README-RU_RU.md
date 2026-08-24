[English](README.md) | [简体中文](README-ZH_CN.md) | [繁體中文](README-ZH_TW.md) | [日本語](README-JA_JP.md) | **Русский**

<div align="center">
  
<img width="80" height="80" alt="QML Icon" src="/public/logo.svg" />

# Qomicex Minecraft Launcher

[![Stars](https://img.shields.io/github/stars/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHBhdGggZD0iTTggLjI1YS43NS43NSAwIDAgMSAuNjczLjQxOGwxLjg4MiAzLjgxNSA0LjIxLjYxMmEuNzUuNzUgMCAwIDEgLjQxNiAxLjI3OWwtMy4wNDYgMi45Ny43MTkgNC4xOTJhLjc1MS43NTEgMCAwIDEtMS4wODguNzkxTDggMTIuMzQ3bC0zLjc2NiAxLjk4YS43NS43NSAwIDAgMS0xLjA4OC0uNzlsLjcyLTQuMTk0TC44MTggNi4zNzRhLjc1Ljc1IDAgMCAxIC40MTYtMS4yOGw0LjIxLS42MTFMNy4zMjcuNjY4QS43NS43NSAwIDAgMSA4IC4yNVoiIGZpbGw9IiNlYWM1NGYiLz48L3N2Zz4=&logoSize=auto&label=stars&labelColor=444444&color=eac54f)](https://github.com/Qomicex-Public/Qomicex.Tauri/)
![GitHub Release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?label=release&logo=github&style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Qomicex-Public/Qomicex.Tauri/ci.yml?style=for-the-badge)

[![Issues](https://img.shields.io/github/issues/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=issues&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/issues)
[![Pull requests](https://img.shields.io/github/issues-pr/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=pull%20requests&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/pulls)
![GitHub Downloads (all assets, all releases)](https://ghapi.qomicex.top/?style=for-the-badge&color=green)

[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![License: GPLv3](https://img.shields.io/badge/License-GPL%20V3-yellow?style=flat-square)](LICENSE)
[![Release](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml/badge.svg)](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml)

<div align="center">
   
[Официальный сайт](https://www.qomicex.top)
[Скачать последнюю версию](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest)

</div>

</div>

[Qomicex Minecraft Launcher](https://github.com/Qomicex-Public/Qomicex.Tauri) (сокращённо QML) сейчас находится на этапе бета-тестирования — приглашаем попробовать.

> Бэкенд лаунчера полностью переписан на Rust (axum). Основные библиотеки и загрузчик перенесены в Rust-сабмодули (`qomicex-core-rust` / `qomicex-connector-rust` / `qomicex-downloader-rust`), зависимость от .NET SDK устранена.

## ✨ Возможности

> Десктопная версия (Tauri v2), вся основная логика реализована на Rust.

Цель Qomicex Launcher (QML) — сделать запуск, установку и управление экземплярами максимально простыми и понятными — независимо от того, играете ли вы каждый день, устанавливаете сборки или играете по сети с друзьями.

### 🚀 Запуск игры

Поддерживается запуск ванильной Minecraft и **автоматическая установка в один клик** большинства мод-лоадеров:

- Vanilla
- Forge
- Fabric
- NeoForge
- Quilt
- Babric
- LegacyFabric
- Cleanroom

Лаунчер читает конфигурацию экземпляра и автоматически собирает libraries, assets, natives, аргументы JVM и параметры игры. После запуска ведётся полный журнал для диагностики сбоев и конфликтов модов.

### 🔐 Вход в аккаунт

Поддерживаются несколько способов входа:

- **Microsoft (лицензия)** — OAuth через код устройства: одноразовый код для авторизации, данные сохраняются локально для следующего входа
- **Офлайн-ник** — для локального тестирования, одиночной игры или сред без проверки лицензии
- **Скиновые серверы Yggdrasil** — встроенные пресеты LittleSkin, Blessing Skin и др.; поддерживается импорт других серверов

Для скиновых серверов доступен **импорт ссылки перетаскиванием**: адрес сервера Yggdrasil распознаётся автоматически (спецификация authlib-injector), ручной ввод не нужен.

### 🌐 Встроенная сетевая игра

В QML встроена сетевая игра по **протоколу Scaffolding** — публичный IP не требуется:

- Создание / подключение к комнатам, определение типа NAT (STUN с перебором портов), релейная сеть
- Кик усилен до **постоянной физической блокировки (deny)**: исключённый игрок не сможет вернуться ни после переподключения, ни после перезапуска
- Защита от случайного кика: окно проверки при переподключении (разрешить / отклонить / отклонить и больше не напоминать), чёрный список хоста с разбаном в один клик
- Проверка модов хоста: отметка отсутствующих, принудительная синхронизация при расхождении
- Совместимость с HMCL, PCL-CE, PCL.Mac и другими лаунчерами с поддержкой протокола Scaffolding

### 📦 Управление экземплярами

Каждая версия игры или сборка сохраняется как **отдельный экземпляр** с изолированными каталогами:

- Установка версий и лоадеров (Forge / Fabric / NeoForge / Quilt и т. д.) в один клик
- Индивидуальное управление модами, сохранениями, ресурс-паками, шейдерами, конфигами, Java и памятью, аргументами JVM для каждого экземпляра
- Пользовательские группы экземпляров для порядка среди множества версий

### 📐 Управление схемами · 3D-просмотр Deepslate

На странице экземпляра встроено управление **схемами Litematica** и их просмотр:

- Список / поиск / открыть папку / локальный импорт (multipart, белый список расширений) / переименование / удаление по одному + массовое удаление
- **WebGL 3D-просмотр Deepslate**: полный просмотр схемы + палитра материалов + ползунок слоя Y + несколько регионов + статистика блоков/материалов
- Материалы извлекаются по требованию из игрового jar пользователя во время работы и кэшируются локально — **ресурсы Mojang не поставляются в комплекте** (соблюдение авторских прав)
- Каталог schematics включён в изоляцию версий, хранится отдельно для каждого экземпляра

### 🗂️ Центр ресурсов

Агрегирует источники **Modrinth / CurseForge / FTB** для поиска ресурсов в одном месте:

- Поиск модов, сборок, шейдеров, ресурс-паков, датапаков, сохранений
- Дополнение китайских названий из MC Wiki для удобства просмотра
- Онлайн-поиск и установка модов, ресурс-паков и шейдеров
- Просмотр деталей ресурса в одном месте

### ⬇️ Центр загрузок

Единый загрузчик отвечает за файлы игры, библиотеки, ресурсы, установщики лоадеров, сборки и онлайн-загрузку модов:

- Собственный высокоскоростной движок загрузки: асинхронная загрузка нескольких файлов, прогресс каждой задачи в реальном времени
- Докачка после обрыва, пауза / возобновление / отмена
- Автоматическое переключение источника при медленной загрузке или сбое, охлаждение текущего источника во избежание запросов к лимитирующим серверам

Все задачи загрузки — установка экземпляров, скачивание модов, среды Java — собраны в центре загрузок с полной видимостью прогресса и причин ошибок.

### 📥 Импорт / экспорт сборок

- **Импорт**: загрузка локального `zip` / Modrinth `.mrpack`, автоматический разбор и установка в один клик; автоматически определяются версия, лоадер, моды, конфигурация и каталоги ресурсов; при отмене или сбое установки остатки удаляются автоматически
- **Экспорт**: CurseForge `zip`, Modrinth `mrpack` или собственный формат `.qmodpack`; обратный поиск по хэшу автоматически формирует список файлов
- Экспорт с **поштучным выбором файлов** в стиле HMCL: своё имя пакета / версия / автор, асинхронные задачи с прогрессом, возможностью отмены и выбора пути сохранения

### 🧩 Управление модами

У каждого экземпляра своя страница управления:

- Просмотр установленных модов, включение / отключение, удаление
- Открытие каталога экземпляра и часто используемых папок (mods, saves, resourcepacks, shaderpacks, config)
- Онлайн-поиск и установка модов, загрузка ресурс-паков и шейдеров
- **Проверка обновлений модов**: пакетное сравнение хэшей Modrinth / CurseForge, список изменений передаётся центру загрузок для планирования обновлений

При отключении мода файл сохраняется — меняется только состояние, что упрощает поиск конфликтов.

### 📎 Автоустановка зависимостей модов

При установке мода QML автоматически разбирает **список зависимостей** из источника Modrinth / CurseForge:

- Распознавание и отображение **обязательных зависимостей**, с рекурсивным разбором глубоких зависимостей
- Установка зависимостей вместе с целевым модом одним кликом — никаких ошибок «не хватает зависимости»
- Необязательные зависимости можно пропустить, выбирая объём установки

### ☕ Управление средой Java

Разным версиям нужна разная Java. QML выбирает её автоматически по версии экземпляра:

- Автоматический скан установленных в системе Java
- Онлайн-загрузка недостающих Java 8 / 17 / 21
- Ручное указание пути Java, отдельные настройки для каждого экземпляра
- Проверка соответствия Java версии игры при запуске

### 💾 Редактор сохранений и настроек игры

- **Редактор настроек сохранения (level.dat NBT)**: визуальное редактирование режима игры, сложности, погоды, точки спавна, границ мира, игровых правил; поддержка восстановления из `level.dat_old`
- **Настройки игры**: визуальное редактирование `options.txt` с описаниями на разных языках; значения-массивы (resourcePacks / datapacks и т. п.) редактируются как чипы

### 🩺 Анализ логов и диагностика сбоев

После сбоя игры можно проанализировать журнал запуска:

- **Локальный анализ по правилам**: 44 встроенных шаблона ошибок, сортировка Critical > Error > Warning > Info; без дополнительной настройки
- **AI-анализ** (через плагин): укажите совместимый с OpenAI адрес API, ключ и название модели

### 🧩 Система плагинов

QML предоставляет расширяемую экосистему плагинов:

- Точки вклада манифеста, встроенный рендеринг / оверлеи iframe, межплагинные вызовы методов
- **Шлюз L3 WASM-плагинов** (песочница wasmtime, написана на Rust): плагины выполняются как WebAssembly в ограниченной песочнице
- Загрузка и установка пакетов плагинов (`.qplugin`), состояние сохраняется локально

### 🎨 Персонализация и мультиязычность

- **I18N**: 7 языков — китайский (упрощённый / традиционный) / английский (US / GB) / японский / русский, с опцией «как в системе» и переключением на лету
- Пользовательский шрифт интерфейса (перечисление системных шрифтов с живым предпросмотром)
- Встроенный / свой фон, цвет темы и другие настройки оформления

## 🔗 Зависимости и связанные проекты

Ключевые возможности QML обеспечивают следующие **Rust-сабмодули** (git-сабмодули в корне репозитория, загружаются командой `git submodule update --recursive`):

- [qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust) — базовая библиотека (игровое ядро GameCore, логика экземпляров / аккаунтов / Java / загрузок)
- [qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust) — единый высокоскоростной загрузчик
- [qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust) — библиотека сетевой игры / протокола SCF (зависит от форка EasyTier4QML)
- [Qomicex.Tauri.i18n](https://github.com/Qomicex-Public/Qomicex.Tauri.i18n) — репозиторий многоязычных ресурсов фронтенда

**Партнёрские / связанные проекты сообщества**:

- [EuoraCraft-Launcher (ECLteam)](https://github.com/ECLteam/EuoraCraft-Launcher) — сторонний лаунчер Minecraft на Python + Tauri от ECLteam, **делит с QML узлы сетевой игры** и **совместим с расширением протокола SCF** для кросс-лаунчерного мультиплеера

## 🔗 Ссылки

| Ссылка | URL |
|:--|:--|
| Официальный сайт | <https://www.qomicex.top> |
| Репозиторий проекта | <https://github.com/Qomicex-Public/Qomicex.Tauri> |
| Загрузки релизов | <https://github.com/Qomicex-Public/Qomicex.Tauri/releases> |
| Вопросы и баги | <https://github.com/Qomicex-Public/Qomicex.Tauri/issues> |
| Мультиязычный репозиторий | <https://github.com/Qomicex-Public/Qomicex.Tauri.i18n> |
| Тестовая группа QQ | [623362446](https://qm.qq.com/q/rKiwzrkg8w) |

## 🎯 Сценарии использования

QML подходит для:

- Ежедневного запуска Minecraft с управлением множеством версий и сборок
- Игры с друзьями по сети (без публичного IP, встроенная организация сети)
- Быстрой установки сборок перетаскиванием / экспорта и обмена в один клик
- Управления модами, ресурс-паками, шейдерами и сохранениями
- Настройки Java и памяти отдельно для каждого экземпляра
- Диагностики неудачных запусков и журналов сбоев
- Лёгкого лаунчера с настраиваемым интерфейсом и поддержкой многих языков

## ℹ️ Как произносится

Qomicex
/kˈɑːmaɪsˌɛks/
≈ q·om·ic·ex

## 🖥️ Поддерживаемые платформы

> Минимальные требования и статус тестирования:

| Платформа | Архитектуры | Минимальная ОС | Статус | Пакет |
|:---|:---|:---|:---|:---|
| **Windows** | `x64`, `ARM64` | Windows 10 1809+ | ✅ Стабильно | `.exe` (установщик NSIS) |
| **macOS** | `x64` (Intel), `ARM64` (Apple Silicon) | macOS 10.15+ | ✅ Стабильно | `.dmg` / `.app` |
| **Linux** | `x64`, `ARM64`, `LoongArch64` (теоретически), `RISC-V 64` (экспериментально) | Ubuntu 20.04+ / Fedora 34+ / glibc 2.28+ | ✅ Стабильно | `.deb` / `.rpm` / AppImage |

![Windows](https://img.shields.io/badge/Windows-10%2B-blue?logo=windows)
![macOS](https://img.shields.io/badge/macOS-10.15%2B-black?logo=apple)
![Linux](https://img.shields.io/badge/Linux-Ubuntu%2020.04%2B-yellow?logo=linux)

## 🔧 Разработка, отладка и сборка

> Технологии: **Rust** (бэкенд axum + Tauri v2) + **React 19 / Vite / TypeScript** (фронтенд) + **pnpm** (воркспейс с `@qomicex/plugin-ui`). Библиотеки ядра и мультиязычные ресурсы подключаются как git-сабмодули.

### Требования

- Инструментарий Rust (stable) + `cargo`; рекомендуются `rust-analyzer` (автодополнение в редакторе) и `codelldb` (отладка, см. `.vscode/launch.json`)
- Node.js + pnpm (управление воркспейсом)
- Для сборки сетевой игры под Windows нужны npcap (`Packet.dll`) и другие рантайм-зависимости — см. `AGENTS.md` и CI `setup-connector-build`

### Инициализация (свежая копия)

```bash
git submodule update --recursive
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # dist/ plugin-ui в gitignore; фронтенд зависит от него
```

### Разработка бэкенда (Rust API)

```bash
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
```

По умолчанию слушает `127.0.0.1:5000`; порт переопределяется переменной окружения `QOMICEX_PORT`; отладка через VS Code `codelldb`.

### Разработка фронтенда (Vite)

```bash
pnpm run dev        # http://localhost:1420, /api проксируется на :5000
```

### Десктоп-разработка (Tauri, окно + бэкенд)

```bash
pnpm run tauri dev
```

### Тесты

```bash
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml   # юнит-тесты бэкенда
cd src-tauri && cargo test --lib plugin_gateway                      # тесты WASM-шлюза плагинов Tauri
pnpm exec tsc --noEmit                                                # проверка типов фронтенда + i18n
bash scripts/test-api-filters.sh    # или .ps1; поведенческие тесты против :5000
```

### Сборка и форматирование

```bash
pnpm run build    # сначала tsc, затем vite build; ошибки типов прерывают сборку
cargo fmt         # обязательно после изменений Rust; CI проверяет форматирование
```

> После правок `packages/plugin-ui/src/` пересоберите пакет plugin-ui; изменения i18n требуют отдельного коммита и пуша в сабмодуле `qomicex-tauri-i18n`.

---

## ⭐ История звёзд

<a href="https://www.star-history.com/?repos=Qomicex-Public%2FQomicex.Tauri&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&theme=dark&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Qomicex-Public/Qomicex.Tauri&type=date&legend=bottom-right&sealed_token=3kRKTiCGJWMYcUcMNuRameNqf5F2KOLMXywaK7Sxym5ZUX3u2Jh3yAam-_le6HA2Jb2oLupvmK1VlTarzTSBkPWaKb7z5gnA7hkq0ZLXwEaAxPsH1o0GQg" />
 </picture>
</a>

## 📄 Лицензия

[GPLv3](LICENSE)

## ❤️ Участники

[![](https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri)](https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors)
