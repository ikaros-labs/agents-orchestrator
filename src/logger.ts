import pino from "pino";
import pretty from "pino-pretty";

const isDev = process.env.NODE_ENV === "development";

const logger = isDev
  ? pino({ level: "debug" }, pretty({ colorize: true }))
  : pino({
      level: "info",
      formatters: {
        level: (label) => ({ level: label }),
      },
    });

export default logger;
