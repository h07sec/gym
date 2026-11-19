export type LogLevel = 'info' | 'warn' | 'error';

export function emitStructuredLog(
  level: LogLevel,
  component: string,
  event: string,
  details?: Record<string, unknown>
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    ...(details || {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
