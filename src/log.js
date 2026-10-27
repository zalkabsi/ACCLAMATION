const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  dim: '\u001b[90m',
  reset: '\u001b[0m',
};

/**
 * Small leveled logger. Structured context is appended as `key=value` pairs so
 * a stream log stays readable while still greppable.
 */
export function createLogger({ level = 'info', name = 'acclamation', color = true, sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const useColor = color && Boolean(sink.log?.constructor);

  function emit(lvl, message, context) {
    if ((LEVELS[lvl] ?? LEVELS.info) < threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    const pairs = context ? formatContext(context) : '';
    const head = `${useColor ? COLORS.dim : ''}${time}${useColor ? COLORS.reset : ''}`;
    const tag = `${useColor ? COLORS[lvl] : ''}${lvl.toUpperCase().padEnd(5)}${useColor ? COLORS.reset : ''}`;
    const prefix = name ? `${name} ` : '';
    sink[lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'log'](
      `${head} ${tag} ${prefix}${message}${pairs ? ` ${useColor ? COLORS.dim : ''}${pairs}${useColor ? COLORS.reset : ''}` : ''}`,
    );
  }

  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (childName) => createLogger({ level, name: `${name}:${childName}`, color, sink }),
  };
}

function formatContext(context) {
  return Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const value = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${value.length > 120 ? `${value.slice(0, 117)}...` : value}`;
    })
    .join(' ');
}

export const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });
