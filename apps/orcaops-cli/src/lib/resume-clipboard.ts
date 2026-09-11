import { spawn } from 'node:child_process';

export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : process.platform === 'linux'
        ? [
            { cmd: 'xclip', args: ['-selection', 'clipboard'] },
            { cmd: 'xsel', args: ['--clipboard', '--input'] },
            { cmd: 'wl-copy', args: [] },
          ]
        : [];

  for (const c of candidates) {
    if (await trySpawnWithStdin(c.cmd, c.args, text)) return true;
  }
  return false;
}

function trySpawnWithStdin(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(text);
  });
}
