# Документация BiliReader

BiliReader — форк [Readest](https://github.com/readest/readest): офлайн-читалка
EPUB/FB2 с встроенным переводом EN→RU на llama.cpp, словарём и режимом
линейки. Точка входа в документацию — этот файл.

## С чего начать

| Документ | Когда читать |
|---|---|
| [STATUS.md](STATUS.md) | что готово, что нет, версия, тесты, известные проблемы |
| [ROADMAP.md](ROADMAP.md) | что делать дальше: Android, релиз, опции |
| [PORTING.md](PORTING.md) | как поднять проект на новой машине или ОС |
| [../FORK.md](../FORK.md) | короткая справка о форке, лицензии и сборке |

## Устройство и процесс

| Документ | Содержание |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | слои, потоки данных, ключевые файлы, IPC- и TS-контракты, инварианты |
| [DECISIONS.md](DECISIONS.md) | журнал решений в формате ADR: контекст → решение → следствия |
| [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) | роли, план-контракт, гейты, git, диск, старт на новой машине |
| [planning/README.md](planning/README.md) | архив исследований и планов из `output/`, порядок чтения и что устарело |

## Возможности

| Документ | Содержание |
|---|---|
| [dictionary.md](dictionary.md) | встроенный FreeDict EN–RU: источник, лицензия, поток поиска, обновление |
| [models.md](models.md) | манифест модели, скачивание, `Range`, SHA-256, зеркала |
| [local-provider.md](local-provider.md) | провайдер `local`: embedded и HTTP-транспорты, ошибки, кэш |
| [local-engine.md](local-engine.md) | встроенный llama.cpp: версии, потоки, IPC, замеры |
| [fonts.md](fonts.md) | офлайн-шрифты PT Serif/Sans, лицензия OFL |
| [manual-test.md](manual-test.md) | ручная приёмка B1–B17: чтение, темы, перевод, словарь, модель |

## Сборка и окружение

| Документ | Содержание |
|---|---|
| [baseline.md](baseline.md) | базовая сборка Linux, CEF, замеры и ограничения |
| [lean-workflow.md](lean-workflow.md) | экономный цикл разработки, бюджет диска, clean-скрипт |
| [toolchain.md](toolchain.md) | версии Node, Rust, GTK, CEF, Android |
| [local-mt-server.md](local-mt-server.md) | `llama-server` для web-сборки и загрузка GGUF вручную |

## Соглашения

- Ссылки относительные: документ должен открываться и в GitHub, и локально.
- Абсолютные домашние пути не пишутся: проект — `<project>`, домашний
  каталог — `$HOME`.
- `output/` — локальный каталог агентов, в git не входит. Всё, что должно
  пережить перенос, лежит в `docs/` (планы — в [planning/](planning/README.md)).
