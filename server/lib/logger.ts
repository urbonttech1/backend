import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'urbont-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    redact: {
      paths: ['req.headers.authorization', 'body.password', 'body.token', 'body.code'],
      censor: '[REDACTED]',
    },
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'pid,hostname,service',
          messageFormat: '{msg}',
        },
      })
    : undefined,
);

export function createContextLogger(context: string) {
  return logger.child({ context });
}
