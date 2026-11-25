import clsx from 'clsx';
import React, { useCallback, useEffect, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { formatBytes } from '@/utils/book';
import { eventDispatcher } from '@/utils/event';
import { openExternalUrl } from '@/utils/open';
import { isTauriAppPlatform } from '@/services/environment';
import { DEFAULT_LOCAL_TRANSLATOR_SETTINGS } from '@/services/constants';
import { fetchModelManifest, getModelEntries, type ModelEntry } from '@/services/models/manifest';
import {
  install,
  ModelInstallError,
  remove,
  scan,
  type ModelProgress,
  type ModelScanResult,
} from '@/services/models/modelManager';
import type { LocalTranslatorSettings } from '@/types/settings';
import { SettingsRow } from './primitives';

const LICENSE_URLS: Record<string, string> = {
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  MIT: 'https://opensource.org/licenses/MIT',
};

const describeError = (_: (key: string) => string, error: unknown): string => {
  if (error instanceof ModelInstallError) {
    switch (error.code) {
      case 'network':
        return _('The download failed. Check your connection and try again — it resumes.');
      case 'checksum':
        return _('The downloaded file is corrupted and was removed. Please try again.');
      case 'disk':
        return _('Not enough disk space, or the models folder is not writable.');
      case 'cancelled':
        return _('Download cancelled.');
      case 'unsupported':
        return _('The offline engine is not available in this build.');
    }
  }
  return _('The model could not be installed.');
};

/**
 * Offline translation model (desktop only): status, download with resume,
 * progress, removal and the folder the embedded engine reads.
 *
 * Rendered inside the Language settings list next to the translation provider
 * rows, so it inherits that card layout instead of opening a sub-page.
 */
const OfflineEnginePanel: React.FC = () => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings } = useSettingsStore();
  const supported = isTauriAppPlatform();
  const modelsDirSetting = (settings.localTranslator?.modelsDir ?? '').trim();

  const [entry, setEntry] = useState<ModelEntry | null>(null);
  const [result, setResult] = useState<ModelScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);

  const saveLocalTranslatorSettings = async (
    patch: Partial<LocalTranslatorSettings>,
  ): Promise<void> => {
    const store = useSettingsStore.getState();
    const current = store.settings.localTranslator ?? DEFAULT_LOCAL_TRANSLATOR_SETTINGS;
    const newSettings = { ...store.settings, localTranslator: { ...current, ...patch } };
    store.setSettings(newSettings);
    await store.saveSettings(envConfig, newSettings);
  };

  const refresh = useCallback(
    async (model: ModelEntry): Promise<void> => {
      if (!appService) return;
      setResult(await scan({ entry: model, modelsDir: modelsDirSetting, appService }));
    },
    [appService, modelsDirSetting],
  );

  useEffect(() => {
    if (!supported || !appService) return;
    let cancelled = false;
    setLoading(true);
    fetchModelManifest()
      .then(async (manifest) => {
        if (cancelled) return;
        const model = getModelEntries(manifest, 'translation')[0] ?? null;
        setEntry(model);
        if (model) {
          setResult(await scan({ entry: model, modelsDir: modelsDirSetting, appService }));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError({ message: _('The model list could not be loaded.'), detail: String(err) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Scan once per app-service instance; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, appService]);

  if (!supported) return null;

  const handleDownload = async (): Promise<void> => {
    if (!appService || !entry || busy) return;
    setBusy(true);
    setError(null);
    setProgress({ downloaded: 0, total: entry.size_bytes, speed: 0 });
    try {
      const installed = await install({
        entry,
        appService,
        modelsDir: modelsDirSetting || undefined,
        onProgress: setProgress,
      });
      // The engine reads `modelsDir`; persist it so the provider probes the
      // folder actually holding the file instead of the environment default.
      if (installed.dir !== modelsDirSetting) {
        await saveLocalTranslatorSettings({ modelsDir: installed.dir });
      }
      setResult(await scan({ entry, modelsDir: installed.dir, appService }));
      if (installed.status && !installed.status.ready) {
        setError({
          message: _('The model is installed but the engine could not load it.'),
          detail: installed.status.error ?? undefined,
        });
      } else {
        eventDispatcher.dispatch('toast', {
          type: 'success',
          message: _('Translation model installed'),
        });
      }
    } catch (err) {
      setError({ message: describeError(_, err), detail: (err as Error)?.message });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleRemove = async (): Promise<void> => {
    if (!appService || !entry || busy) return;
    const confirmed = await appService.ask(
      _('Delete the offline translation model from this device? You can download it again later.'),
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      // Remove from the folder the scan found the file in — it may be the
      // engine default (BIREADER_MODELS_DIR) rather than the configured one.
      await remove({ entry, appService, modelsDir: result?.dir || modelsDirSetting || undefined });
      await refresh(entry);
      eventDispatcher.dispatch('toast', { type: 'info', message: _('Translation model removed') });
    } catch (err) {
      setError({ message: describeError(_, err), detail: (err as Error)?.message });
    } finally {
      setBusy(false);
    }
  };

  if (!entry) {
    return (
      <SettingsRow
        label={_('Offline engine')}
        description={loading ? _('Checking…') : _('No model is published for this build.')}
        data-setting-id='settings.language.offlineEngine'
      >
        {loading && <span className='loading loading-spinner loading-sm' />}
      </SettingsRow>
    );
  }

  const sizeLabel = formatBytes(entry.size_bytes);
  const licenseUrl = LICENSE_URLS[entry.license];
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
      : 0;
  const statusLabel = busy
    ? _('Downloading…')
    : result?.installed
      ? result.ready
        ? _('Installed')
        : _('Installed, engine error')
      : loading
        ? _('Checking…')
        : _('Not installed');

  return (
    <>
      <SettingsRow
        label={_('Offline engine')}
        description={`${entry.display_name} · ${sizeLabel}${
          result?.freeSpaceBytes ? ` · ${formatBytes(result.freeSpaceBytes)} ${_('free')}` : ''
        }`}
        data-setting-id='settings.language.offlineEngine'
      >
        <span
          className={clsx(
            'text-xs',
            result?.ready
              ? 'text-success'
              : result?.installed
                ? 'text-warning'
                : 'text-base-content/60',
          )}
        >
          {statusLabel}
        </span>
      </SettingsRow>

      {busy && progress && (
        <SettingsRow
          label={_('Downloading…')}
          align='start'
          data-setting-id='settings.language.offlineProgress'
        >
          <div className='flex w-40 flex-col items-end gap-1'>
            <progress className='progress progress-primary w-full' value={percent} max={100} />
            <span className='text-base-content/60 text-[0.8em]'>
              {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
            </span>
          </div>
        </SettingsRow>
      )}

      {error && (
        <SettingsRow
          label={error.message}
          description={error.detail}
          data-setting-id='settings.language.offlineError'
        >
          <button
            type='button'
            className='btn btn-sm btn-ghost'
            onClick={() => setError(null)}
            aria-label={_('Dismiss')}
          >
            {_('Dismiss')}
          </button>
        </SettingsRow>
      )}

      <SettingsRow
        label={_('Model')}
        description={`${_('License')}: ${entry.license} · ${_('needs')} ${formatBytes(
          entry.min_ram_mb * 1024 * 1024,
        )} ${_('RAM')}`}
        data-setting-id='settings.language.offlineModel'
      >
        <div className='flex items-center gap-2'>
          {licenseUrl && (
            <button
              type='button'
              className='btn btn-sm btn-ghost'
              onClick={() => openExternalUrl(licenseUrl)}
            >
              {entry.license}
            </button>
          )}
          {result?.installed ? (
            <button
              type='button'
              className='btn btn-sm btn-error'
              onClick={handleRemove}
              disabled={busy}
            >
              {_('Delete')}
            </button>
          ) : (
            <button
              type='button'
              className='btn btn-sm btn-contrast eink-bordered'
              onClick={handleDownload}
              disabled={busy || loading}
            >
              {busy ? _('Downloading…') : `${_('Download')} (${sizeLabel})`}
            </button>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        label={_('Models folder')}
        description={result?.dir ?? ''}
        data-setting-id='settings.language.offlineFolder'
      />
    </>
  );
};

export default OfflineEnginePanel;
