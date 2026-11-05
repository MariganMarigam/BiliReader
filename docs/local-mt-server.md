# Local MT server (llama.cpp + Hy-MT2-1.8B)

An offline EN→RU translation endpoint owned by the app: `llama-server` (CPU only)
serving Tencent's Hy-MT2-1.8B Q4_K_M over an OpenAI-compatible API. The app talks
to it through the existing **OpenAI Compatible** custom translator, so no
application code changes are involved.

Measured on this machine (i7-13620H, 16 threads, no GPU): see
[Measurements](#measurements).

## Install

Everything lives outside the repository, about 1.2 GB total:

| Path | Size | What |
| --- | --- | --- |
| `~/.local/share/bilireader/llama/llama-b12125/` | 56 MB | prebuilt llama.cpp (CPU) |
| `~/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf` | 1.13 GB | Hy-MT2-1.8B, Apache-2.0 |

```sh
# 1. llama.cpp — official prebuilt CPU release, no source build needed
mkdir -p ~/.local/share/bilireader/{llama,models}
curl -L -o /tmp/llama.tar.gz \
  https://github.com/ggml-org/llama.cpp/releases/download/b12125/llama-b12125-bin-ubuntu-x64.tar.gz
tar -xzf /tmp/llama.tar.gz -C ~/.local/share/bilireader/llama/
~/.local/share/bilireader/llama/llama-b12125/llama-server --version

# 2. model — Q4_K_M only: the 1.25-bit and 2-bit GGUFs need a patched llama.cpp
curl -L -o ~/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf \
  https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf
sha256sum ~/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf
```

| Artifact | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `Hy-MT2-1.8B-Q4_K_M.gguf` | 1 133 080 448 | `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699` |

The SHA-256 above is the official LFS OID from
`huggingface.co/tencent/Hy-MT2-1.8B-GGUF`; any other value means a corrupted or
foreign file.

> Network note for this machine: bulk CDN transfers from `huggingface.co` stall
> intermittently on DNS resolution. If the download hangs, pin the edge:
> `curl --resolve huggingface.co:443:52.222.136.89 --resolve us.aws.cdn.hf.co:443:15.236.78.196 ...`
> or pull the identical blob from the Ollama registry (layer digest equals the
> SHA-256 above): `registry.ollama.ai/v2/maternion/hy-mt2/blobs/sha256:dc5f44...`.

## Run

```sh
scripts/bilireader-mt-server.sh start    # background, ready in a few seconds
scripts/bilireader-mt-server.sh status
scripts/bilireader-mt-server.sh logs 200
scripts/bilireader-mt-server.sh stop
```

`start` returns immediately, writes `/tmp/opencode/mt-server.log`, and waits up
to 120 s for `GET /health` before reporting the ready time. Defaults: port 8080,
context 512, 4 threads, all layers on the CPU (`-ngl 0`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BILIREADER_MT_PORT` | `8080` | listen port |
| `BILIREADER_MT_CTX` | `512` | context window |
| `BILIREADER_MT_THREADS` | `4` | CPU threads |
| `BILIREADER_MT_LOG` | `/tmp/opencode/mt-server.log` | log + pid file |

512 tokens is enough for a single paragraph. The app batches up to **4 segments
or 3000 characters** per request (`MAX_BATCH_ITEMS`/`MAX_BATCH_CHARS` in
`src/services/translators/custom/openaiCompatible.ts`), which can exceed 512
tokens; for real reading use `BILIREADER_MT_CTX=2048` (costs ~40 MB more RSS).

## Connect from the app

Settings → **Language** → **Custom Translators** → *Add Translator*. (The row is
badged *Premium* when the account is not premium; custom translators are gated.)
The fields come from `apps/readest-app/src/components/settings/CustomTranslatorEditor.tsx`:

| Field | Value | Notes |
| --- | --- | --- |
| **Type** | `OpenAI Compatible` | the other option, DeepL, does not apply |
| **Name** | `Local Hy-MT2` | free text, shown in the translator list |
| **Base URL** | `http://127.0.0.1:8080/v1` | must include `/v1`; requests go to `<Base URL>/chat/completions` |
| **API Key** | *leave empty* | the field is optional for local servers; `llama-server` ignores it |
| **Model** | `hy-mt2-1.8b` | must equal the `--alias` in the script; the refresh button lists it from `/v1/models` |
| **Temperature** | `0.7` | model card recommendation; `0` gives deterministic, flatter prose |
| **Thinking** | `Default` | Hy-MT2 has no thinking mode; `Off` only adds `reasoning_effort: none` |
| **Enabled** | on | |

Press **Test** (translates "Hello, world.") before **Save**.

Caveats for this model:

- Hy-MT2 is instruction-tuned with **no default system prompt**. The app sends
  its literary system prompt (`DEFAULT_TRANSLATION_PROMPT`) and the raw text as
  the user turn, which the model follows reasonably but less strictly than its
  native format (`Translate the following text into Russian. Note that you should
  only output the translated result…`). If output quality disappoints, put that
  instruction into a custom translation prompt in the app rather than editing code.
- Keep `Temperature ≤ 0.7`; higher values make it invent sentences.
- The API is plain HTTP on loopback, no auth. Do not expose the port.

## Check quality

With the server running:

```sh
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"hy-mt2-1.8b","messages":[
        {"role":"system","content":"You are a professional literary translator translating a book from English into Russian."},
        {"role":"user","content":"The old lighthouse keeper."}],
      "temperature":0.7,"max_tokens":256}'
```

Check, in this order: the sentence means what the source means; no added or
dropped clauses; no repetition loops; names and numbers survive; punctuation and
paragraph breaks match the source; Russian reads naturally rather than
word-by-word. The five probes used below are one word, a four-word phrase, a
short sentence, a long sentence, and two sentences with a name and pronoun
reference.

## Measurements

Machine: 13th Gen Intel i7-13620H (16 threads), no GPU, CPU-only build
`b12125`, `-ngl 0`, 4 threads, context 512, Q4_K_M. Client-side wall clock per
request (`/v1/chat/completions`, temperature 0.7, top_p 0.6, top_k 20,
repetition penalty 1.05, max 256 tokens).

| Metric | Value |
| --- | --- |
| Cold start to `/health` 200 (model load 1.72 s in the log) | **2 s** |
| RSS / PSS after warm-up | **1.91 GB / 1.90 GB** |
| Prompt size (system prompt + probe) | 67–94 tokens |

| # | Probe | Source (EN) | Translation (RU) | Latency |
| --- | --- | --- | --- | --- |
| 1 | one word | serendipity | сюрприз | 658 ms |
| 2 | four-word phrase | The old lighthouse keeper. | Старик-фонарщик | 373 ms |
| 3 | short sentence | She closed the book and looked out of the window. | Она закрыла книгу и посмотрела в окно. | 607 ms |
| 4 | long sentence | Although the storm had been raging since dawn, the villagers refused to abandon their homes, and by nightfall every lamp in the valley was still burning. | Хотя буря шла с рассвета, жители деревни отказались покидать свои дома, и к вечеру все лампы в долине все еще горели. | 1 729 ms |
| 5 | two sentences, context | Mr. Thornton had never trusted the ferryman. When the fog rolled in that evening, he finally understood why. | Мистер Торнтон никогда не доверял паромщику. Когда в тот вечер поднялся туман, он наконец понял почему. | 1 707 ms |

Repeat of probe 4 with the prompt cache disabled (`cache_prompt: false`):
**2 185 / 2 190 / 2 250 ms** — flat, so repeated uncached requests do not degrade.
With the app's fixed system prompt the server reuses the shared prefix and the
same request takes **1 540 ms** (`cached_tokens: 88`).

Quality, read by hand against the five probes:

- **Sentences are the strong case.** #3 is exact; #4 keeps the concession, the
  subject change and the final clause; #5 keeps the name (`Mr. Thornton` →
  `Мистер Торнтон`), resolves the pronoun correctly across the sentence break,
  and leaves no commentary.
- **Isolated words fail.** #1 renders *serendipity* as *сюрприз* ("surprise"),
  which is wrong; with no sentence around it the model guesses a near neighbour.
- **Compounds drift.** #2 *lighthouse keeper* → *фонарщик* ("lamplighter") is
  natural Russian but drops the lighthouse. Correct would be
  *смотритель маяка*.
- **No garbage, no loops, no notes.** All five replies are one clean block whose
  length tracks the source; nothing was repeated and the model never explained
  itself (the `special_eos_id is not in special_eog_ids` warning at load is
  harmless — generation stops on `<｜hy_place▁holder▁no▁2｜>`).
- **The native prompt format is slightly better.** Sending the model card's
  `Translate the following text into Russian…` instruction as the user turn
  (instead of the app's system prompt + raw text) gives *«Хотя буря бушевала с
  рассвета…»* for #4 — more vivid than *«буря шла»* — at +200 ms. If prose
  quality matters more than turnaround, use a custom translation prompt with
  that wording.
- **Throughput.** Probe 4 renders 50 output tokens in 2.19 s uncached (≈23 tok/s)
  and 1.54 s with the prefix cache (≈32 tok/s), prompt evaluation included. A
  250-word page is ~350 output tokens, i.e. roughly 11–15 s of CPU time when
  split into the app's 4-segment batches.

## Remove the model and free space

```sh
scripts/bilireader-mt-server.sh stop
rm -f ~/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf   # 1.13 GB
rm -rf ~/.local/share/bilireader/llama                          # 56 MB
```

Nothing else is written outside `/tmp/opencode/` (log, pid) and the model
directory. `scripts/bilireader-clean.sh` does not touch these paths — they are
not build output.
