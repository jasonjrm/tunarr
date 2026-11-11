import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type FreeResources = {
  /** Free memory on the first NVIDIA GPU, MiB. Undefined when nvidia-smi isn't available. */
  vramMb?: number;
  /** MemAvailable from /proc/meminfo, MiB. Undefined off Linux. */
  ramMb?: number;
};

/**
 * Free GPU memory and available RAM right now, for stream admission. A probe
 * that fails is left out rather than failing the tune-in.
 */
export async function probeFreeResources(): Promise<FreeResources> {
  const [vram, ram] = await Promise.allSettled([
    execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 2_000 },
    ).then(({ stdout }) => parseInt(stdout.split('\n')[0]!.trim(), 10)),
    readFile('/proc/meminfo', 'utf-8').then((meminfo) => {
      const match = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
      return match ? Math.floor(parseInt(match[1]!, 10) / 1024) : NaN;
    }),
  ]);
  const value = (r: PromiseSettledResult<number>) =>
    r.status === 'fulfilled' && Number.isFinite(r.value) ? r.value : undefined;
  return { vramMb: value(vram), ramMb: value(ram) };
}
