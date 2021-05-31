import { getLogger, Logger, configure } from "log4js"

enum Level {
    TRACE = "TRACE",
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARN = "WARN",
    ERROR = "ERROR",
}

export class Log {
    static getLogger<T>(category: string): Log {
        return new Log(category)
    }

    private readonly log: Logger

    constructor(readonly category: string) {
        const logPersit = process.env.LOG_PERSISTENCE!
        if (logPersit == "true"){
            configure({
                appenders: {
                    log_file: {
                        type: "dateFile",
                        filename: "./config/log/log_file",
                        pattern: "yyyy-MM-dd.log",
                        alwaysIncludePattern: true,
                    },
                },
                categories: { default: { appenders: ["log_file"], level: "DEBUG" } }
            });
        }
        this.log = getLogger(category)
    }

    isTraceEnabled(): boolean {
        return this.log.isTraceEnabled()
    }

    isDebugEnabled(): boolean {
        return this.log.isDebugEnabled()
    }

    trace(e: string | Error): void {
        this.log.trace(e)
    }

    debug(e: string | Error): void {
        this.log.debug(e)
    }

    info(e: string | Error): void {
        this.log.info(e)
    }

    jinfo(obj: object): void {
        this.log.info(JSON.stringify(obj))
    }

    warn(e: string | Error): void {
        this.log.warn(e)
    }

    jwarn(obj: object): void {
        const strObj = JSON.stringify(obj)
        this.log.warn(strObj)
    }

    error(e: string | Error): void {
        this.log.error(e)
    }

    jerror(obj: object): void {
        const strObj = JSON.stringify(obj)
        this.log.error(strObj)
    }

    fatal(e: string | Error): void {
        this.log.fatal(e)
    }

    jfatal(obj: object): void {
        const strObj = JSON.stringify(obj)
        this.log.fatal(strObj)
    }
}
