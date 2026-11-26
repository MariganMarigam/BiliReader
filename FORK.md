# BiliReader

Форк [Readest](https://github.com/readest/readest) — офлайн-читалка EPUB/FB2 с переводом EN→RU на llama.cpp.

- Лицензия: [AGPL-3.0](LICENSE); исходники форка открыты.
- Документация: [docs/README.md](docs/README.md).
- Сборка Linux: `scripts/bilireader-build-linux.sh` (≥ 8 ГБ свободно, 25–45 мин).
- Запуск без релизной сборки: `scripts/bilireader-run.sh`.
- Модель `Hy-MT2-1.8B-Q4_K_M.gguf` (1.13 ГБ) не входит в бандл — скачивается в Settings → Language → Offline engine.
- Ветка разработки: `bilireader/main`; upstream — `readest/readest`.
