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
to 180 s for `GET /health` before reporting the ready time. Defaults: port 8080,
context 512, 2 threads, all layers on the CPU (`-ngl 0`). Give the start call
itself a 300 s timeout: the wait loop covers a cold model load plus a slow disk.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BILIREADER_MT_PORT` | `8080` | listen port |
| `BILIREADER_MT_CTX` | `512` | context window |
| `BILIREADER_MT_THREADS` | `2` | CPU threads |
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

Machine: 13th Gen Intel i7-13620H (16 threads, `nproc` = 16), no GPU, CPU-only
build `b12125`, `-ngl 0`, **2 threads**, context 512, Q4_K_M. Client-side wall
clock per request (`/v1/chat/completions`, temperature 0, max 256 tokens, user
turn = the model card's native `Translate the following English text to Russian.
Output only the translation.` + the source text).

| Metric | Value |
| --- | --- |
| Cold start to `/health` 200 (model load 0.93 s in the log) | **1 s** (`ready in 1s`) |
| RSS / VSZ after six requests (2 threads, ctx 512) | **1 887 MiB / 2 941 MiB** |
| Prompt size (instruction + probe) | 18–75 tokens |

| # | Probe | Source (EN) | Translation (RU) | Latency | Output tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | one word | mortgage | ипотека | 252 ms (470 ms on the first, cold call) | 5 |
| 2 | four-word idiom | take it for granted | Считать это само собой | 515 ms | 10 |
| 3 | short sentence | I will call you tomorrow morning. | Я позвоню вам завтра утром. | 745 ms | 14 |
| 4 | long literary sentence | The old lighthouse keeper climbed the spiral stairs every evening, though the lamp had been dark for thirty years, and no ship had asked the question it once answered. | Старый стражник маяка каждый вечер поднимался по спиральным ступеням, хотя лампа не светила уже тридцать лет, и ни одна лодка не задавала того вопроса, на который она когда-то отвечала. | 3 582 ms | 72 |
| 5 | two sentences, context | The bank refused to extend the loan. The manager said the collateral was insufficient. | Банк отказался продлить кредит. Менеджер сказал, что залог недостаточен. | 1 569 ms | 32 |

Throughput on probe 4: 72 output tokens in 3.58 s ≈ **20 tok/s** with 2 threads;
higher thread counts do not help much on this CPU (4 threads measured 23–32 tok/s
on prose in an earlier run, at the cost of more heat).

Quality, read by hand against the five probes:

- **Sentences are the strong case.** #3 is exact (it picks the polite *вам* for
  the English *you*, which is the safe literary default); #4 keeps both clauses,
  the concession, the time span and the closing relative clause; #5 answers the
  context question correctly — *bank* becomes a financial *банк* because the
  sentence talks about a loan and collateral.
- **Isolated idioms get cut short.** #2 returns *Считать это само собой*, the
  first half of *считать само собой разумеющимся*: with a bare phrase and a
  128-token budget the model stops mid-idiom. Give it a full sentence
  ("Don't take it for granted.") and the phrase completes.
- **Lexical drift in long clauses.** #4 renders *keeper* as *стражник*
  ("guard") instead of *смотритель маяка* and *ship* as *лодка* ("boat"). The
  sentence still reads naturally and means the same thing, which is the trade-off
  of a 1.8B model: no grammar errors, occasional loss of a specific noun.
- **No garbage, no loops, no notes.** All five replies are one clean block whose
  length tracks the source; nothing was repeated and the model never explained
  itself (the `special_eos_id is not in special_eog_ids` warning at load is
  harmless — generation stops on `<｜hy_place▁holder▁no▁2｜>`).
- **The native prompt format is slightly better.** Sending the model card's
  `Translate the following text into Russian…` instruction as the user turn
  (instead of the app's system prompt + raw text) gives more vivid prose for the
  same content at roughly +200 ms on long sentences. The measurements above use
  that format; the app sends its own literary system prompt, so expect the app's
  output to be a little flatter. If prose quality matters more than turnaround,
  put the native instruction into a custom translation prompt in the app.
- **Cost per page.** At ~20 tok/s a 250-word page (~350 output tokens) takes
  roughly 17 s of CPU time, split into the app's 4-segment batches; the shared
  system-prompt prefix is cached between requests, so repeats are ~25% faster.

## Remove the model and free space

```sh
scripts/bilireader-mt-server.sh stop
rm -f ~/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf   # 1.13 GB
rm -rf ~/.local/share/bilireader/llama                          # 56 MB
```

Nothing else is written outside `/tmp/opencode/` (log, pid) and the model
directory. `scripts/bilireader-clean.sh` does not touch these paths — they are
not build output.
