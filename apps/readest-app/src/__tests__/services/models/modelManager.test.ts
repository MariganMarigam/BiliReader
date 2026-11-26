import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { ModelEntry } from '@/services/models/manifest';
import {
  install,
  ModelInstallError,
  remove,
  scan,
  pathFor,
  type ModelDownloader,
  type ModelFileSystem,
} from '@/services/models/modelManager';
import type { AppService } from '@/types/system';
import type { ProgressPayload } from '@/utils/transfer';

vi.mock('@/libs/storage', () => ({ downloadFile: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  open: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  SeekMode: { Start: 0, Current: 1, End: 2 },
}));

const MODELS_DIR = '/data/Readest/bilireader/models';
const MODEL_FILE = 'Hy-MT2-1.8B-Q4_K_M.gguf';

const content = (() => {
  const bytes = new Uint8Array(5000);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
})();

const shaOf = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

const PRIMARY = `https://huggingface.co/o/r/resolve/0123456789abcdef/${MODEL_FILE}`;
const FALLBACK = `https://github.com/o/r/releases/download/models-v1/${MODEL_FILE}`;

const entry = (overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id: 'hy-mt2-1.8b-q4_k_m',
  kind: 'translation',
  lang_pair: 'en-ru',
  urls: [FALLBACK],
  size_bytes: content.length,
  sha256: shaOf(content),
  license: 'Apache-2.0',
  min_ram_mb: 3072,
  display_name: 'Hy-MT2 1.8B (Q4_K_M)',
  ...overrides,
});

class MemoryFs implements ModelFileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();

  write(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async size(path: string): Promise<number> {
    const file = this.files.get(path);
    if (!file) throw new Error(`missing: ${path}`);
    return file.length;
  }

  async mkdirp(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string, recursive = false): Promise<void> {
    this.files.delete(path);
    if (recursive) {
      for (const key of [...this.files.keys()]) {
        if (key.startsWith(`${path}/`)) this.files.delete(key);
      }
    }
    this.dirs.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw new Error(`missing: ${from}`);
    this.files.set(to, file);
    this.files.delete(from);
  }

  async append(dst: string, src: string): Promise<void> {
    const head = this.files.get(dst) ?? new Uint8Array(0);
    const tail = this.files.get(src) ?? new Uint8Array(0);
    const merged = new Uint8Array(head.length + tail.length);
    merged.set(head, 0);
    merged.set(tail, head.length);
    this.files.set(dst, merged);
  }

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    return (this.files.get(path) ?? new Uint8Array(0)).subarray(offset, offset + length);
  }
}

interface SimulatedDownload {
  failAfter?: number;
  ignoreRange?: boolean;
  error?: Error;
  /** Serves content of the right length with the first byte flipped. */
  corrupt?: boolean;
}

const makeRoutingDownloader = (
  fs: MemoryFs,
  behavior: (url: string) => SimulatedDownload,
): ModelDownloader & { calls: Array<{ url: string; dst: string; range?: string }> } => {
  const calls: Array<{ url: string; dst: string; range?: string }> = [];
  const downloader = async ({
    url,
    dst,
    headers,
    onProgress,
  }: {
    url: string;
    dst: string;
    headers?: Record<string, string>;
    onProgress?: (payload: ProgressPayload) => void;
  }): Promise<Record<string, string> | undefined> => {
    const opts = behavior(url);
    const range = headers?.['Range'];
    calls.push({ url, dst, range });
    if (opts.error) throw opts.error;
    let bytes = content;
    if (opts.corrupt) {
      bytes = content.slice();
      bytes[0] = (bytes[0]! + 1) % 256;
    }
    const start = opts.ignoreRange || !range ? 0 : Number(/bytes=(\d+)-/.exec(range)![1]);
    const end =
      opts.failAfter !== undefined ? Math.min(bytes.length, start + opts.failAfter) : bytes.length;
    fs.write(dst, bytes.subarray(start, end));
    onProgress?.({ progress: end - start, total: bytes.length, transferSpeed: 1 });
    if (opts.failAfter !== undefined) throw new Error('NetworkError: connection lost');
    const responseHeaders: Record<string, string> = {};
    if (range && !opts.ignoreRange) {
      responseHeaders['content-range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
    }
    return responseHeaders;
  };
  return Object.assign(downloader, { calls });
};

const makeDownloader = (fs: MemoryFs, opts: SimulatedDownload = {}) =>
  makeRoutingDownloader(fs, () => opts);

const engineStatus = (
  ready: boolean,
  modelPath: string | null = null,
  error: string | null = null,
) =>
  vi.fn(async () => ({
    ready,
    engine: 'llama.cpp',
    llama_cpp_commit: 'test',
    model_path: modelPath,
    n_ctx: 512,
    threads: 2,
    error,
  }));

const appService = { ask: vi.fn() } as unknown as AppService;

const baseDeps = (fs: MemoryFs, download: ModelDownloader, free = 10 * 1024 * 1024) => ({
  fs,
  download,
  freeSpace: vi.fn(async () => free),
  engineStatus: engineStatus(true, `${MODELS_DIR}/${MODEL_FILE}`),
  resolveManagedDir: vi.fn(async () => MODELS_DIR),
});

describe('pathFor', () => {
  it('names the file after the release asset so Rust finds it', () => {
    expect(pathFor(MODELS_DIR, entry())).toBe(`${MODELS_DIR}/${MODEL_FILE}`);
    expect(pathFor(`${MODELS_DIR}/`, entry())).toBe(`${MODELS_DIR}/${MODEL_FILE}`);
    expect(pathFor(MODELS_DIR, { id: 'x', urls: ['https://h/x.gguf'] })).toBe(
      `${MODELS_DIR}/x.gguf`,
    );
  });
});

describe('install', () => {
  it('downloads, verifies and renames the model into place', async () => {
    const fs = new MemoryFs();
    const download = makeDownloader(fs);
    const progress: number[] = [];

    const result = await install({
      entry: entry(),
      modelsDir: MODELS_DIR,
      appService,
      onProgress: (p) => progress.push(p.downloaded),
      deps: { ...baseDeps(fs, download), engineStatus: engineStatus(true, null) },
    });

    expect(result.path).toBe(`${MODELS_DIR}/${MODEL_FILE}`);
    expect(result.status?.engine).toBe('llama.cpp');
    expect(bytesToHex(sha256(fs.files.get(result.path)!))).toBe(entry().sha256);
    expect(fs.files.has(`${MODELS_DIR}/.tmp/${entry().id}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(content.length);
  });

  it('uses the first source and never contacts the fallback', async () => {
    const fs = new MemoryFs();
    const download = makeRoutingDownloader(fs, () => ({}));

    const result = await install({
      entry: entry({ urls: [PRIMARY, FALLBACK] }),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, download),
    });

    expect(download.calls.map((call) => call.url)).toEqual([PRIMARY]);
    expect(result.path).toBe(`${MODELS_DIR}/${MODEL_FILE}`);
    expect(fs.files.has(`${MODELS_DIR}/${MODEL_FILE}`)).toBe(true);
  });

  it('restarts from the next source when the first dies mid-download', async () => {
    const fs = new MemoryFs();
    const download = makeRoutingDownloader(fs, (url) =>
      url === PRIMARY ? { failAfter: 1800 } : {},
    );

    const result = await install({
      entry: entry({ urls: [PRIMARY, FALLBACK] }),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, download),
    });

    expect(download.calls.map((call) => call.url)).toEqual([PRIMARY, FALLBACK]);
    // Bytes from one host are never appended to bytes from another.
    expect(download.calls[1]!.range).toBeUndefined();
    expect(bytesToHex(sha256(fs.files.get(result.path)!))).toBe(entry().sha256);
  });

  it('fails with the last source error when every source fails', async () => {
    const fs = new MemoryFs();
    const download = makeRoutingDownloader(fs, (url) =>
      url === PRIMARY
        ? { error: new Error('404 Not Found') }
        : { error: new Error('403 Forbidden') },
    );

    await expect(
      install({
        entry: entry({ urls: [PRIMARY, FALLBACK] }),
        modelsDir: MODELS_DIR,
        appService,
        deps: baseDeps(fs, download),
      }),
    ).rejects.toMatchObject({ code: 'network' });

    expect(download.calls.map((call) => call.url)).toEqual([PRIMARY, FALLBACK]);
    expect(fs.files.has(`${MODELS_DIR}/${MODEL_FILE}`)).toBe(false);
  });

  it('retries the fallback when the first source serves a corrupt file', async () => {
    const fs = new MemoryFs();
    const download = makeRoutingDownloader(fs, (url) => (url === PRIMARY ? { corrupt: true } : {}));

    const result = await install({
      entry: entry({ urls: [PRIMARY, FALLBACK] }),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, download),
    });

    expect(download.calls.map((call) => call.url)).toEqual([PRIMARY, FALLBACK]);
    // The corrupt part is discarded, so the fallback starts at zero.
    expect(download.calls[1]!.range).toBeUndefined();
    expect(bytesToHex(sha256(fs.files.get(result.path)!))).toBe(entry().sha256);
  });

  it('resumes an interrupted download with a Range request', async () => {
    const fs = new MemoryFs();
    const first = makeDownloader(fs, { failAfter: 1800 });

    await expect(
      install({
        entry: entry(),
        modelsDir: MODELS_DIR,
        appService,
        deps: baseDeps(fs, first),
      }),
    ).rejects.toMatchObject({ code: 'network' });

    const part = `${MODELS_DIR}/.tmp/${entry().id}.part`;
    expect(fs.files.get(part)?.length).toBe(1800);

    const second = makeDownloader(fs);
    await install({
      entry: entry(),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, second),
    });

    expect(second.calls[0]!.range).toBe('bytes=1800-');
    expect(fs.files.get(`${MODELS_DIR}/${MODEL_FILE}`)?.length).toBe(content.length);
    expect(fs.files.has(part)).toBe(false);
    expect(fs.files.has(`${part}.tail`)).toBe(false);
  });

  it('rejects a checksum mismatch and deletes the corrupt part', async () => {
    const fs = new MemoryFs();

    await expect(
      install({
        entry: entry({ sha256: 'a'.repeat(64) }),
        modelsDir: MODELS_DIR,
        appService,
        deps: baseDeps(fs, makeDownloader(fs)),
      }),
    ).rejects.toMatchObject({ code: 'checksum' });

    expect(fs.files.has(`${MODELS_DIR}/.tmp/${entry().id}.part`)).toBe(false);
    expect(fs.files.has(`${MODELS_DIR}/${MODEL_FILE}`)).toBe(false);
  });

  it('fails with a disk error before downloading when space is short', async () => {
    const fs = new MemoryFs();
    const download = makeDownloader(fs);

    await expect(
      install({
        entry: entry(),
        modelsDir: MODELS_DIR,
        appService,
        deps: baseDeps(fs, download, 1000),
      }),
    ).rejects.toMatchObject({ code: 'disk' });
    expect(download.calls).toHaveLength(0);
  });

  it('reports a network failure when there is no connection and keeps no part', async () => {
    const fs = new MemoryFs();
    const download = makeDownloader(fs, { error: new Error('Failed to fetch') });

    const failure = install({
      entry: entry(),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, download),
    });

    await expect(failure).rejects.toBeInstanceOf(ModelInstallError);
    await expect(failure).rejects.toMatchObject({ code: 'network' });
    expect(fs.files.size).toBe(0);
  });
});

describe('remove', () => {
  it('deletes the installed model and the temp tree', async () => {
    const fs = new MemoryFs();
    await install({
      entry: entry(),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, makeDownloader(fs)),
    });

    await remove({
      entry: entry(),
      modelsDir: MODELS_DIR,
      appService,
      deps: baseDeps(fs, makeDownloader(fs)),
    });

    expect(fs.files.has(`${MODELS_DIR}/${MODEL_FILE}`)).toBe(false);
  });
});

describe('scan', () => {
  it('reports a model already present in the engine default directory', async () => {
    const fs = new MemoryFs();
    const managedPath = `${MODELS_DIR}/${MODEL_FILE}`;
    const envPath = '/home/u/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf';
    fs.write(envPath, content);

    const result = await scan({
      entry: entry(),
      appService,
      deps: {
        ...baseDeps(fs, makeDownloader(fs)),
        engineStatus: engineStatus(true, envPath),
      },
    });

    expect(result.installed).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.path).toBe(envPath);
    expect(result.dir).toBe('/home/u/.local/share/bilireader/models');
    expect(result.sizeBytes).toBe(content.length);
    expect(fs.files.has(managedPath)).toBe(false);
  });

  it('falls back to the managed directory when nothing is installed', async () => {
    const fs = new MemoryFs();
    const result = await scan({
      entry: entry(),
      appService,
      deps: {
        ...baseDeps(fs, makeDownloader(fs)),
        engineStatus: engineStatus(
          false,
          null,
          'model missing: /home/u/.local/share/bilireader/models/Hy-MT2-1.8B-Q4_K_M.gguf',
        ),
      },
    });

    expect(result.installed).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.dir).toBe('/home/u/.local/share/bilireader/models');
  });
});
