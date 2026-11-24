/**
 * Embedded (Tauri IPC) transport of the `local` translator.
 *
 * On desktop the engine lives inside the app: `translate_local` per paragraph,
 * `cancel_translation` per job, and one `local_engine_status` before the first
 * call. The HTTP path must stay untouched for the web build.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock, generateTextMock, settingsState, envState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  generateTextMock: vi.fn(),
  settingsState: {
    settings: undefined as
      | {
          localTranslator?: {
            endpoint?: string;
            model?: string;
            temperature?: number;
            modelsDir?: string;
          };
        }
      | undefined,
  },
  envState: { tauri: true },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => envState.tauri,
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => settingsState },
}));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});

type InvokeArgs = {
  modelsDir?: string;
  jobId?: string;
  text?: string;
  context?: string | null;
};

const READY = {
  ready: true,
  engine: 'llama-cpp-2',
  llama_cpp_commit: 'deadbeef',
  model_path: '/models/Hy-MT2-1.8B-Q4_K_M.gguf',
  n_ctx: 4096,
  threads: 4,
  error: null,
};

const okTranslation = (args: InvokeArgs) => ({
  job_id: args.jobId ?? '',
  text: `fr:${args.text}`,
  tokens: 3,
  ms: 5,
  cancelled: false,
});

/** Fresh module graph so the once-per-process engine status cache resets. */
const loadProvider = async () => {
  vi.resetModules();
  const mod = await import('@/services/translators/providers/local');
  return mod.localProvider;
};

describe('localProvider (embedded Tauri transport)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    generateTextMock.mockReset();
    envState.tauri = true;
    settingsState.settings = {
      localTranslator: { model: 'm1', temperature: 0.2, modelsDir: '' },
    };
  });

  it('checks the engine once and translates texts sequentially with distinct job ids', async () => {
    invokeMock.mockImplementation((cmd: string, args: InvokeArgs) => {
      if (cmd === 'local_engine_status') return Promise.resolve(READY);
      if (cmd === 'translate_local') return Promise.resolve(okTranslation(args));
      throw new Error(`unexpected command ${cmd}`);
    });
    const provider = await loadProvider();

    const out = await provider.translate(['One', 'Two', 'Three'], 'en', 'fr');

    expect(out).toEqual(['fr:One', 'fr:Two', 'fr:Three']);
    const cmds = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(cmds.filter((c) => c === 'local_engine_status')).toHaveLength(1);
    expect(cmds.filter((c) => c === 'translate_local')).toHaveLength(3);

    const statusArgs = invokeMock.mock.calls.find(([cmd]) => cmd === 'local_engine_status')![1];
    expect(statusArgs).toEqual({ modelsDir: '' });

    const translated = invokeMock.mock.calls
      .filter(([cmd]) => cmd === 'translate_local')
      .map(([, args]) => args as InvokeArgs);
    expect(translated.map((a) => a.text)).toEqual(['One', 'Two', 'Three']);
    const ids = translated.map((a) => a.jobId);
    expect(new Set(ids).size).toBe(3);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('cancels the active job on abort and stops the loop', async () => {
    let finishActive: ((value: unknown) => void) | null = null;
    invokeMock.mockImplementation((cmd: string, args: InvokeArgs) => {
      if (cmd === 'local_engine_status') return Promise.resolve(READY);
      if (cmd === 'translate_local') {
        if (args.text === 'Two') {
          return new Promise((resolve) => {
            finishActive = resolve;
          });
        }
        return Promise.resolve(okTranslation(args));
      }
      if (cmd === 'cancel_translation') {
        finishActive?.({
          job_id: args.jobId ?? '',
          text: '',
          tokens: 0,
          ms: 1,
          cancelled: true,
        });
        return Promise.resolve(true);
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    const provider = await loadProvider();
    const controller = new AbortController();

    const pending = provider.translate(
      ['One', 'Two', 'Three'],
      'en',
      'fr',
      null,
      false,
      controller.signal,
    );
    // Let the first item finish and the second IPC call start.
    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === 'translate_local').length,
      ).toBeGreaterThanOrEqual(2);
    });
    const secondJobId = (
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'translate_local')[1]![1] as InvokeArgs
    ).jobId;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const cancelCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'cancel_translation');
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]![1]).toEqual({ jobId: secondJobId });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'translate_local')).toHaveLength(2);
  });

  it('fails with a local-unavailable error when the model is not installed', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'local_engine_status') {
        return Promise.resolve({
          ...READY,
          ready: false,
          model_path: null,
          error: 'model missing: /models/Hy-MT2-1.8B-Q4_K_M.gguf',
        });
      }
      throw new Error(`unexpected command ${cmd}`);
    });
    const provider = await loadProvider();

    await expect(provider.translate(['One'], 'en', 'fr')).rejects.toThrow(
      /Local Translator Unavailable.*model.*install/i,
    );
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'translate_local')).toBe(false);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('maps an IPC "engine not loaded" rejection to the unavailable code', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'local_engine_status') return Promise.resolve(READY);
      return Promise.reject(new Error('engine not loaded; call local_engine_status first'));
    });
    const provider = await loadProvider();

    await expect(provider.translate(['One'], 'en', 'fr')).rejects.toThrow(
      /Local Translator Unavailable.*engine/i,
    );
  });

  it('tags the cache key with the embedded transport', async () => {
    invokeMock.mockResolvedValue(READY);
    const provider = await loadProvider();

    const embedded = provider.getCacheKey!('en', 'fr', {});
    envState.tauri = false;
    const http = provider.getCacheKey!('en', 'fr', {});

    expect(embedded).toContain('embedded');
    expect(http).toContain('http');
    expect(embedded).not.toBe(http);
  });

  it('keeps the HTTP path on the web platform', async () => {
    envState.tauri = false;
    generateTextMock.mockResolvedValue({ text: 'Bonjour' });
    const provider = await loadProvider();

    const out = await provider.translate(['Hello'], 'en', 'fr');

    expect(out).toEqual(['Bonjour']);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
