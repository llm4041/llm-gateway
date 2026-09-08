type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level: Level, msg: string, extra?: unknown): void {
  const line = `${COLORS[level]}[${ts()}] ${level.toUpperCase()}${RESET} ${msg}`;
  if (level === 'error') console.error(line, extra ?? '');
  else console.log(line, extra ?? '');
}

export const logger = {
  debug: (m: string, e?: unknown) => write('debug', m, e),
  info: (m: string, e?: unknown) => write('info', m, e),
  warn: (m: string, e?: unknown) => write('warn', m, e),
  error: (m: string, e?: unknown) => write('error', m, e),
};
