import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { smetTime } from './config.ts';
import { parseSmet } from './parse.ts';

const exec = promisify(execFile);

export interface SnowpackRun {
  stdout: string;
  stderr: string;
  durationMs: number;
}

// SNOWPACK is a native CLI: config + SMET forcing + initial .sno in, .smet
// time series + .pro profiles + final .sno out. It can exit 0 having
// simulated nothing (e.g. "No valid data for station"), so success is judged
// by the output reaching the requested end time.
export async function runSnowpack(opts: {
  bin: string;
  runDir: string;
  iniPath: string;
  end: Date;
  timeoutMs: number;
  outputSmetPath: string;
}): Promise<SnowpackRun> {
  const started = Date.now();
  let stdout: string;
  let stderr: string;
  try {
    const out = await exec(
      opts.bin,
      ['-c', opts.iniPath, '-e', smetTime(opts.end)],
      {
        cwd: opts.runDir,
        timeout: opts.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    await writeLogs(opts.runDir, e.stdout ?? '', e.stderr ?? '');
    throw new Error(
      `snowpack failed: ${e.message}\n${tail(e.stdout, e.stderr)}`,
      {
        cause: err,
      },
    );
  }
  await writeLogs(opts.runDir, stdout, stderr);
  const durationMs = Date.now() - started;

  const lastTime = await lastOutputTime(opts.outputSmetPath);
  if (!lastTime || lastTime.getTime() < opts.end.getTime()) {
    throw new Error(
      `snowpack stopped at ${lastTime?.toISOString() ?? 'the start'} instead of ${opts.end.toISOString()}\n${tail(stdout, stderr)}`,
    );
  }
  return { stdout, stderr, durationMs };
}

async function lastOutputTime(path: string): Promise<Date | null> {
  try {
    await access(path);
  } catch {
    return null;
  }
  const smet = parseSmet(await readFile(path, 'utf8'));
  return smet.rows.at(-1)?.time ?? null;
}

async function writeLogs(runDir: string, stdout: string, stderr: string) {
  await writeFile(join(runDir, 'snowpack.stdout.log'), stdout);
  await writeFile(join(runDir, 'snowpack.stderr.log'), stderr);
}

function tail(stdout = '', stderr = ''): string {
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .filter((l) => /^\s*\[[EW]\]|error|Error/.test(l));
  return lines.slice(-20).join('\n');
}

// "Snowpack version 3.7.0 compiled on …" from the bare invocation's usage text.
export async function snowpackVersion(bin: string): Promise<string | null> {
  let text: string;
  try {
    const out = await exec(bin, [], { timeout: 10_000 });
    text = `${out.stdout}\n${out.stderr}`;
  } catch (err) {
    // The bare invocation prints usage and may exit non-zero.
    const e = err as { stdout?: string; stderr?: string };
    text = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  return /Snowpack version (\S+)/.exec(text)?.[1] ?? null;
}
