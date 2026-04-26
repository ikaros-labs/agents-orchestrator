import pino from "pino";

const isDev = process.env.NODE_ENV === "development";

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  }),
});

export function createLogger(name: string) {
  return rootLogger.child({ name });
}
