import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/misc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/misc')>()),
  uniqueId: () => 'bundle1',
}));

vi.mock('@/utils/md5', () => ({
  md5: (value: string) => `md5_${value}`,
  partialMD5: async () => 'partial',
}));

import { FileSystem } from '@/types/system';
import { MAX_FONT_FILE_SIZE } from '@/utils/font';
import { importFont } from '@/services/fontService';

const makeFs = () => {
  const fs = {
    createDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue({ name: 'font.ttf' }),
  };
  return { fs: fs as unknown as FileSystem, spies: fs };
};

/** Minimal object that satisfies the `File` branch of `importFont`. */
const makeFile = (name: string, bytes: ArrayBuffer): File =>
  ({ name, arrayBuffer: async () => bytes }) as unknown as File;

const fontBytes = (signature: number, size = 64): ArrayBuffer => {
  const buf = new ArrayBuffer(size);
  new DataView(buf).setUint32(0, signature, false);
  return buf;
};

describe('importFont validation', () => {
  let env: ReturnType<typeof makeFs>;

  beforeEach(() => {
    env = makeFs();
  });

  it('rejects a file with an unrecognised signature without touching the filesystem', async () => {
    await expect(importFont(env.fs, makeFile('notes.ttf', fontBytes(0x25504446)))).rejects.toThrow(
      '"notes.ttf" is not a valid font file',
    );
    expect(env.spies.createDir).not.toHaveBeenCalled();
    expect(env.spies.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a truncated file without touching the filesystem', async () => {
    await expect(importFont(env.fs, makeFile('tiny.ttf', new ArrayBuffer(8)))).rejects.toThrow(
      'is not a valid font file',
    );
    expect(env.spies.createDir).not.toHaveBeenCalled();
  });

  it('rejects files above the 20 MB limit without touching the filesystem', async () => {
    const oversized = fontBytes(0x00010000, MAX_FONT_FILE_SIZE + 1);
    await expect(importFont(env.fs, makeFile('huge.ttf', oversized))).rejects.toThrow(
      'The maximum font size is 20 MB',
    );
    expect(env.spies.createDir).not.toHaveBeenCalled();
  });

  it('imports a structurally valid font into its bundle dir', async () => {
    const info = await importFont(env.fs, makeFile('Roboto.ttf', fontBytes(0x00010000)));
    expect(env.spies.createDir).toHaveBeenCalledWith('bundle1', 'Fonts', true);
    expect(env.spies.writeFile).toHaveBeenCalledWith(
      'bundle1/Roboto.ttf',
      'Fonts',
      expect.anything(),
    );
    expect(info?.path).toBe('bundle1/Roboto.ttf');
    expect(info?.bundleDir).toBe('bundle1');
    expect(info?.byteSize).toBe(64);
  });
});
