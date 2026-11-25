/**
 * Offline translation-model manager (desktop only).
 *
 * Responsibilities: report what is installed, download the GGUF with Range
 * resume into `<models dir>/.tmp/<id>.part`, verify SHA-256, rename atomically
 * into place, delete, and wake the embedded engine afterwards.
 *
 * Paths are absolute and come from the app service (`BaseDir 'Data'`) — the
 * same directory tree Rust's `download_file` authorises. The engine is then
 * pointed at that directory through `local_engine_status({ modelsDir })`, which
 * accepts any absolute path, so no Rust change is needed to relocate models.
 */

import { invoke } from '@tauri-apps/api/core';
import { mkdir, open, remove as removePath, rename, stat, SeekMode } from '@tauri-apps/plugin-fs';
import { isTauriAppPlatform } from '@/services/environment';
import type { LocalEngineStatus } from '@/services/translators/providers/local';
import { downloadFile } from '@/libs/storage';
import type { AppService } from '@/types/system';
import type { ProgressPayload } from '@/utils/transfer';
import type { ModelEntry } from './manifest';

/** Managed model tree under `BaseDir 'Data'` (i.e. `<appData>/Readest/...`). */
export const MODELS_SUBDIR = 'bilireader/models';
/** Partial downloads live here so a half-written model is never loadable. */
export const TMP_SUBDIR = '.tmp';
/** Read/append window for hashing and resume merging. */
const IO_CHUNK_BYTES = 4 * 1024 * 1024;

export type ModelInstallErrorCode = 'network' | 'checksum' | 'disk' | 'cancelled' | 'unsupported';

/** Typed install failure so the UI can pick a human-readable message. */
export class ModelInstallError extends Error {
  readonly code: ModelInstallErrorCode;

  constructor(code: ModelInstallErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ModelInstallError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Absolute-path file primitives. Injectable so tests drive install/resume/
 * checksum against an in-memory tree without the Tauri runtime.
 */
export interface ModelFileSystem {
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  mkdirp(path: string): Promise<void>;
  /** `recursive` must be set for directories. */
  remove(path: string, recursive?: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Append `src` to `dst`, preserving `dst`'s bytes. */
  append(dst: string, src: string): Promise<void>;
  /** Read up to `length` bytes at `offset`; fewer only at EOF. */
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
}

export type ModelDownloader = (params: {
  appService?: AppService;
  dst: string;
  url: string;
  headers?: Record<string, string>;
  singleThreaded?: boolean;
  onProgress?: (payload: ProgressPayload) => void;
}) => Promise<Record<string, string> | undefined>;

export interface ModelDeps {
  download: ModelDownloader;
  fs: ModelFileSystem;
  /** Free bytes on the target volume, or `null` when unknowable. */
  freeSpace: () => Promise<number | null>;
  engineStatus: (modelsDir: string) => Promise<LocalEngineStatus>;
  resolveManagedDir: (appService: AppService) => Promise<string>;
}

export interface ModelProgress {
  downloaded: number;
  total: number;
  speed: number;
}

export interface ModelScanResult {
  installed: boolean;
  /** Engine loaded the model successfully. */
  ready: boolean;
  /** Absolute GGUF path, when one was found. */
  path: string | null;
  /** Directory the engine will read models from (download target when absent). */
  dir: string;
  sizeBytes: number | null;
  freeSpaceBytes: number | null;
  engineError: string | null;
}

export interface ModelInstallResult {
  path: string;
  dir: string;
  sizeBytes: number;
  /** Engine status after the install; `null` when the probe itself failed. */
  status: LocalEngineStatus | null;
}

const nativeFs: ModelFileSystem = {
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  size: async (path) => (await stat(path)).size,
  mkdirp: async (path) => {
    try {
      await mkdir(path, { recursive: true });
    } catch (error) {
      // Some platforms reject an already-existing directory instead of no-oping.
      if (!(await nativeFs.exists(path))) throw error;
    }
  },
  remove: async (path, recursive = false) => {
    try {
      await removePath(path, { recursive });
    } catch (error) {
      if (!(await nativeFs.exists(path))) return;
      throw error;
    }
  },
  rename: async (from, to) => {
    if (await nativeFs.exists(to)) await removePath(to);
    await rename(from, to);
  },
  append: async (dst, src) => {
    const source = await open(src, { read: true });
    const target = await open(dst, { write: true, create: true, append: true });
    try {
      const buffer = new Uint8Array(IO_CHUNK_BYTES);
      for (;;) {
        const read = await source.read(buffer);
        if (read === null || read === 0) break;
        await target.write(buffer.subarray(0, read));
      }
    } finally {
      await target.close().catch(() => undefined);
      await source.close().catch(() => undefined);
    }
  },
  readChunk: async (path, offset, length) => {
    const handle = await open(path, { read: true });
    try {
      await handle.seek(offset, SeekMode.Start);
      const buffer = new Uint8Array(length);
      const read = await handle.read(buffer);
      return read === null ? new Uint8Array(0) : buffer.subarray(0, read);
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
};

const defaultDownloader: ModelDownloader = async ({
  appService,
  dst,
  url,
  headers,
  singleThreaded,
  onProgress,
}) => {
  if (!appService) throw new ModelInstallError('unsupported', 'App service is not ready');
  const responseHeaders = await downloadFile({
    appService,
    dst,
    cfp: '',
    url,
    headers,
    singleThreaded,
    onProgress,
  });
  return responseHeaders as Record<string, string> | undefined;
};

/**
 * Free space on the models volume.
 *
 * No Rust command exposes `statvfs` and the Rust side is out of scope for this
 * stage, so the desktop answer is "unknown" rather than a guessed browser
 * quota. The UI labels it accordingly; a full disk still surfaces as a `disk`
 * error from the downloader.
 */
export const estimateFreeSpace = async (): Promise<number | null> => null;

/** Idempotent engine probe; the engine loads on first successful probe. */
export const probeEngine = async (modelsDir: string): Promise<LocalEngineStatus> => {
  if (!isTauriAppPlatform()) {
    throw new ModelInstallError('unsupported', 'The embedded engine is desktop-only');
  }
  return invoke<LocalEngineStatus>('local_engine_status', { modelsDir });
};

export const managedModelsDir = async (appService: AppService): Promise<string> =>
  appService.resolveFilePath(MODELS_SUBDIR, 'Data');

/** Release assets must keep Rust's `MODEL_FILENAME` or the engine won't find them. */
export const modelFileName = (entry: Pick<ModelEntry, 'id' | 'url'>): string => {
  const base = entry.url.split('/').pop()?.split('?')[0] ?? '';
  return base && base !== entry.id ? base : `${entry.id}.gguf`;
};

/** Absolute path of an installed model (`pathFor` from the model-manager spec). */
export const pathFor = (modelsDir: string, entry: Pick<ModelEntry, 'id' | 'url'>): string =>
  `${modelsDir.replace(/\/+$/, '')}/${modelFileName(entry)}`;

const withDeps = (override?: Partial<ModelDeps>): ModelDeps => ({
  download: defaultDownloader,
  fs: nativeFs,
  freeSpace: estimateFreeSpace,
  engineStatus: probeEngine,
  resolveManagedDir: managedModelsDir,
  ...override,
});

/**
 * SHA-256 of a file read in bounded chunks (a 1.1 GB model must never be
 * buffered whole).
 */
export const sha256OfFile = async (
  fs: ModelFileSystem,
  path: string,
  size: number,
): Promise<string> => {
  const { sha256 } = await import('@noble/hashes/sha256');
  const { bytesToHex } = await import('@noble/hashes/utils');
  const digest = sha256.create();
  let offset = 0;
  while (offset < size) {
    const chunk = await fs.readChunk(path, offset, Math.min(IO_CHUNK_BYTES, size - offset));
    if (chunk.length === 0) {
      throw new ModelInstallError('disk', `Unexpected end of ${path} at ${offset} of ${size}`);
    }
    digest.update(chunk);
    offset += chunk.length;
  }
  return bytesToHex(digest.digest());
};

const requireAppService = (appService?: AppService): AppService => {
  if (!appService) {
    throw new ModelInstallError('unsupported', 'App service is not ready');
  }
  return appService;
};

const headerValue = (
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
};

const isAbort = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true;
  const name = (error as { name?: string })?.name;
  return name === 'AbortError' || name === 'CancelledError';
};

const toInstallError = (error: unknown, signal?: AbortSignal): ModelInstallError => {
  if (error instanceof ModelInstallError) return error;
  if (isAbort(error, signal)) {
    return new ModelInstallError('cancelled', 'Download cancelled', error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/no space|enospc|disk full|quota/i.test(message)) {
    return new ModelInstallError('disk', `Not enough disk space: ${message}`, error);
  }
  if (/forbidden|not allowed|scope|permission denied/i.test(message)) {
    return new ModelInstallError(
      'disk',
      `The app may not write to the models folder: ${message}`,
      error,
    );
  }
  return new ModelInstallError('network', `Download failed: ${message}`, error);
};

const dirName = (path: string): string => path.replace(/\/[^/]+$/, '');

/**
 * Inspect installation state without touching the network.
 *
 * Probes, in order: the configured models directory (empty means the engine
 * default, i.e. `BIREADER_MODELS_DIR` or `<data_dir>/bilireader/models`), then
 * the app-managed directory. A model already present in either place is
 * reported as installed and is never downloaded again.
 */
export const scan = async (options: {
  entry: ModelEntry;
  /** `settings.localTranslator.modelsDir`; empty/absent means engine default. */
  modelsDir?: string;
  appService?: AppService;
  deps?: Partial<ModelDeps>;
}): Promise<ModelScanResult> => {
  const { entry, appService } = options;
  const deps = withDeps(options.deps);
  const managedDir = await deps.resolveManagedDir(requireAppService(appService));
  const configured = (options.modelsDir ?? '').trim();
  const candidates = configured ? [configured, managedDir] : ['', managedDir];

  let ready: LocalEngineStatus | null = null;
  let engineError: string | null = null;
  let probedDir = configured || managedDir;
  for (const dir of [...new Set(candidates)]) {
    try {
      const status = await deps.engineStatus(dir);
      engineError = status.error ?? engineError;
      if (status.ready) {
        ready = status;
        probedDir = dir;
        break;
      }
      const missing = /model missing: (.+)$/m.exec(status.error ?? '')?.[1]?.trim();
      if (missing) probedDir = dirName(missing);
    } catch (error) {
      engineError = error instanceof Error ? error.message : String(error);
    }
  }

  if (ready?.model_path) {
    const sizeBytes = await deps.fs.size(ready.model_path).catch(() => null);
    return {
      installed: true,
      ready: true,
      path: ready.model_path,
      dir: dirName(ready.model_path),
      sizeBytes: sizeBytes ?? entry.size_bytes,
      freeSpaceBytes: await deps.freeSpace(),
      engineError: null,
    };
  }

  // The engine did not load it; still report a file that exists on disk so the
  // panel can show what is there and offer to remove it.
  const presentPath = pathFor(probedDir, entry);
  const sizeBytes = (await deps.fs.exists(presentPath))
    ? await deps.fs.size(presentPath).catch(() => null)
    : null;

  return {
    installed: sizeBytes !== null,
    ready: false,
    path: sizeBytes !== null ? presentPath : null,
    dir: probedDir,
    sizeBytes,
    freeSpaceBytes: await deps.freeSpace(),
    engineError,
  };
};

/**
 * Download, verify and install one model.
 *
 * Resume: bytes already in `.tmp/<id>.part` are kept and the remainder is
 * requested with `Range: bytes=<have>-` into `.tmp/<id>.part.tail`, then merged
 * in bounded chunks. A failed attempt therefore never truncates progress and a
 * half-written file is never renamed into place.
 */
export const install = async (options: {
  entry: ModelEntry;
  modelsDir?: string;
  appService?: AppService;
  onProgress?: (progress: ModelProgress) => void;
  signal?: AbortSignal;
  deps?: Partial<ModelDeps>;
}): Promise<ModelInstallResult> => {
  const { entry, signal } = options;
  const deps = withDeps(options.deps);
  const { fs } = deps;
  const dir =
    (options.modelsDir ?? '').trim() ||
    (await deps.resolveManagedDir(requireAppService(options.appService)));
  const destination = pathFor(dir, entry);
  const tmpDir = `${dir}/${TMP_SUBDIR}`;
  const part = `${tmpDir}/${entry.id}.part`;
  const tail = `${part}.tail`;
  const total = entry.size_bytes;

  signal?.throwIfAborted();

  // A completed file already in place only needs re-verification.
  const existing = await fs.exists(destination);
  if (existing) {
    const existingSize = await fs.size(destination);
    if (existingSize === total) {
      const digest = await sha256OfFile(fs, destination, existingSize);
      if (digest === entry.sha256) {
        await fs.remove(part).catch(() => undefined);
        return { path: destination, dir, sizeBytes: total, status: await safeProbe(deps, dir) };
      }
      await fs.remove(destination);
    }
  }

  await fs.mkdirp(dir);
  await fs.mkdirp(tmpDir);

  let have = (await fs.exists(part)) ? await fs.size(part) : 0;
  if (have > total) {
    await fs.remove(part);
    have = 0;
  }

  if (have < total) {
    const free = await deps.freeSpace();
    if (free !== null && free < total - have) {
      throw new ModelInstallError(
        'disk',
        `Not enough disk space: ${total - have} bytes required, ${free} available`,
      );
    }

    const report = (payload: ProgressPayload, base: number): void =>
      options.onProgress?.({
        downloaded: Math.min(total, base + payload.progress),
        total,
        speed: payload.transferSpeed,
      });

    try {
      if (have > 0) {
        report({ progress: 0, total, transferSpeed: 0 }, have);
        const headers = await deps.download({
          appService: options.appService,
          dst: tail,
          url: entry.url,
          headers: { Range: `bytes=${have}-` },
          singleThreaded: true,
          onProgress: (payload) => report(payload, have),
        });
        if (headerValue(headers, 'content-range')) {
          await fs.append(part, tail);
          await fs.remove(tail);
        } else {
          // The server ignored Range: `.tail` holds the whole asset.
          await fs.remove(part);
          await fs.rename(tail, part);
        }
      } else {
        await deps.download({
          appService: options.appService,
          dst: part,
          url: entry.url,
          singleThreaded: true,
          onProgress: (payload) => report(payload, 0),
        });
      }
    } catch (error) {
      await fs.remove(tail).catch(() => undefined);
      throw toInstallError(error, signal);
    }

    have = (await fs.exists(part)) ? await fs.size(part) : 0;
    if (have !== total) {
      throw new ModelInstallError(
        'network',
        `Download incomplete: ${have} of ${total} bytes. Retry to resume.`,
      );
    }
  }

  signal?.throwIfAborted();
  options.onProgress?.({ downloaded: total, total, speed: 0 });

  const digest = await sha256OfFile(fs, part, total);
  if (digest !== entry.sha256) {
    await fs.remove(part).catch(() => undefined);
    throw new ModelInstallError(
      'checksum',
      `Checksum mismatch for ${entry.id}: expected ${entry.sha256}, got ${digest}`,
    );
  }

  await fs.rename(part, destination);
  await fs.remove(tmpDir, true).catch(() => undefined);

  return {
    path: destination,
    dir,
    sizeBytes: total,
    status: await safeProbe(deps, dir),
  };
};

const safeProbe = async (deps: ModelDeps, dir: string): Promise<LocalEngineStatus | null> => {
  try {
    return await deps.engineStatus(dir);
  } catch {
    return null;
  }
};

/** Delete the installed model and any partial downloads for it. */
export const remove = async (options: {
  entry: ModelEntry;
  modelsDir?: string;
  appService?: AppService;
  deps?: Partial<ModelDeps>;
}): Promise<void> => {
  const deps = withDeps(options.deps);
  const dir =
    (options.modelsDir ?? '').trim() ||
    (await deps.resolveManagedDir(requireAppService(options.appService)));
  const destination = pathFor(dir, options.entry);
  await deps.fs.remove(destination).catch((error: unknown) => {
    if (error instanceof ModelInstallError) throw error;
    throw new ModelInstallError(
      'disk',
      `Could not delete ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  });
  await deps.fs.remove(`${dir}/${TMP_SUBDIR}`, true).catch(() => undefined);
};
