# Local LLM Setup (llama.cpp)

Tesla supports local inference via llama.cpp's `llama-server`, which exposes an
OpenAI-compatible API. When running, Tesla auto-detects it and routes
private/offline queries there. Cloud models (GPT/Grok) remain available as
fallback.

## Prerequisites

### 1. Install llama.cpp

Download a pre-built binary from the [releases page](https://github.com/ggerganov/llama.cpp/releases).

| Your hardware | Build to download |
|---|---|
| NVIDIA GPU (CUDA 12.x) | `llama-*-bin-win-cuda-cu12.2.0-x64.zip` |
| NVIDIA GPU (CUDA 11.x) | `llama-*-bin-win-cuda-cu11.7.1-x64.zip` |
| CPU only (AVX2) | `llama-*-bin-win-avx2-x64.zip` |
| CPU only (no AVX) | `llama-*-bin-win-noavx-x64.zip` |

Extract to a fixed location, e.g. `C:\llama.cpp\`. You need `llama-server.exe`
from the extracted folder.

### 2. Download a GGUF model

Good starting points from [HuggingFace (bartowski builds)](https://huggingface.co/bartowski):

| Model | VRAM needed | Best for |
|---|---|---|
| `Qwen2.5-14B-Instruct-Q4_K_M.gguf` | ~9 GB | Best quality/speed balance |
| `Qwen2.5-7B-Instruct-Q6_K.gguf` | ~6 GB | Fast, still capable |
| `Qwen2.5-32B-Instruct-Q3_K_M.gguf` | ~14 GB | Highest quality (needs 16GB+) |
| `Llama-3.2-3B-Instruct-Q8_0.gguf` | ~3 GB | Lightweight, low VRAM |

For coding tasks specifically: `Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf`

Put the model file somewhere permanent, e.g. `C:\llama.cpp\models\`.

## Configuration

Edit `scripts\start-llama-server.cmd` and set:

```bat
set LLAMA_EXE=C:\llama.cpp\llama-server.exe
set MODEL_PATH=C:\llama.cpp\models\Qwen2.5-14B-Instruct-Q4_K_M.gguf
```

Other settings in the script (defaults are fine to start):

| Setting | Default | Notes |
|---|---|---|
| `CTX_SIZE` | `8192` | Context window in tokens. Increase to 16384+ if your VRAM allows. |
| `GPU_LAYERS` | `999` | Set to 999 to offload all layers to GPU. Set to 0 for CPU-only. For partial GPU, set to how many layers fit. |
| `PARALLEL` | `4` | Concurrent request slots (one per browser tab / Telegram user). |
| `PORT` | `8080` | Must match `LLAMA_SERVER_URL` in `.env`. |
| `FLASH_ATTN` | `--flash-attn` | Faster + less VRAM. Remove if you see NaN or garbage output. |

Then add to `.env`:

```
LLAMA_SERVER_URL=http://127.0.0.1:8080
LLAMA_MODEL_NAME=Qwen2.5-14B-Instruct-Q4_K_M   # display name only
```

## Running

Start the server in a separate terminal (keep it running alongside Tesla):

```
scripts\start-llama-server.cmd
```

You should see something like:

```
llama server listening at http://127.0.0.1:8080
slot 0: available
```

Then start Tesla normally (`npm run web` or `npm run telegram`). On boot you
will see:

```
[local] GPU detected: 12GB VRAM
[local] llama-server ready: Qwen2.5-14B-Instruct-Q4_K_M (35 GPU layers)
```

## Using the local model

Tesla routes to the local model automatically for private/offline queries.
You can also control routing manually:

| Command | Effect |
|---|---|
| `/model local` | Lock this session to the local model |
| `/model gpt` | Lock to GPT-4.1 |
| `/model grok` | Lock to Grok |
| `/model auto` | Return to automatic routing |

Or say it naturally: *"use local model for this"*, *"run this privately"*,
*"no cloud"* — the router detects these and picks local.

## Troubleshooting

**`llama-server not found`** — Check `LLAMA_EXE` path in the script. Make sure
you extracted the zip.

**`Model not found`** — Check `MODEL_PATH`. Use the full absolute path.

**Out of VRAM / CUDA out of memory** — Reduce `GPU_LAYERS` (e.g. to 20) so
only some layers go to GPU and the rest run on CPU. Or use a smaller/more
quantized model (Q3 instead of Q6).

**Garbage / NaN output** — Remove `--flash-attn` from the launch script.
Some GPU/driver combinations don't support it.

**Slow on CPU** — Normal. A 14B Q4 model does ~5–10 tokens/second on CPU.
Use a smaller model (3B or 7B Q4) for faster CPU inference.

**Tesla says "local model unavailable"** — llama-server isn't running or not
responding on the configured port. Start it first, then start Tesla. Tesla
probes the server every 30 seconds so it will pick it up automatically once
it's running.

## How routing works

On every turn, Tesla's router checks:

1. Is there a session override (`/model local`)? → use that
2. Does the message match local patterns (private, offline, no cloud, etc.)? → local
3. Does it match Grok patterns (social, trending, sentiment)? → Grok
4. Otherwise → GPT

If the local model is selected but llama-server is unreachable, Tesla falls
back to GPT automatically and logs a warning. No errors surface to the user.

## Resource usage

| Model | VRAM | RAM | Tokens/s (GPU) | Tokens/s (CPU) |
|---|---|---|---|---|
| Qwen2.5-14B Q4_K_M | ~9 GB | ~2 GB | ~40–60 | ~8–12 |
| Qwen2.5-7B Q6_K | ~6 GB | ~1.5 GB | ~70–90 | ~15–20 |
| Llama-3.2-3B Q8 | ~3 GB | ~1 GB | ~120+ | ~30–40 |

Numbers are approximate and vary by GPU generation and system.
