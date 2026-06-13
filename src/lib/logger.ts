const levels = { info: '→', warn: '⚠', error: '✗', success: '✓' } as const;

function log(level: keyof typeof levels, stage: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${levels[level]} [${stage}] ${msg}`);
}

export const logger = {
  info: (stage: string, msg: string) => log('info', stage, msg),
  warn: (stage: string, msg: string) => log('warn', stage, msg),
  error: (stage: string, msg: string) => log('error', stage, msg),
  success: (stage: string, msg: string) => log('success', stage, msg),
};
