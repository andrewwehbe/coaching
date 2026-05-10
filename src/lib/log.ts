import 'server-only';

/**
 * Tiny structured logging shim. Goes to console (Vercel collects stdout/stderr
 * automatically) so we can grep with a stable prefix instead of free-form
 * console.error scattered across routes.
 *
 * Usage: log.warn('cron.stale.fired', { workoutId, hoursOpen })
 *        log.error('push.send.failed', err, { deviceId })
 */
type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields) {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function errFields(err: unknown): Fields {
  if (err instanceof Error) {
    return { err: err.message, stack: err.stack };
  }
  return { err: String(err) };
}

export const log = {
  info(event: string, fields: Fields = {}) {
    emit('info', event, fields);
  },
  warn(event: string, fields: Fields = {}) {
    emit('warn', event, fields);
  },
  error(event: string, err: unknown, fields: Fields = {}) {
    emit('error', event, { ...errFields(err), ...fields });
  },
};
