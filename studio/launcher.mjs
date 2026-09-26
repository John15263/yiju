import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { config, root } from './server/config.mjs';

const url = `http://127.0.0.1:${config().port}`;
async function running() {
  let response;
  try { response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }); }
  catch { return false; }
  const health = await response.json().catch(() => null);
  if (!response.ok || health?.service !== 'generative-studio') throw new Error('端口被其他服务占用，请检查后再启动。');
  return true;
}

try {
  if (!await running()) {
    const logs = join(root, 'studio/data');
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const logPath = join(logs, 'launcher.log');
    const log = openSync(logPath, 'a', 0o600); chmodSync(logPath, 0o600);
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'studio/server/main.mjs'], {
      cwd: root, detached: true, stdio: ['ignore', log, log],
    });
    closeSync(log);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    const deadline = Date.now() + 20000;
    while (!await running()) {
      if (Date.now() >= deadline) throw new Error('本地服务未能启动。请查看项目 studio/data/launcher.log。');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  execFileSync('/usr/bin/open', [url]);
  console.log('语言练习已就绪。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
