import "reflect-metadata" // this shim is required
import "source-map-support/register"
import { configure } from "log4js"

export const PROJECT_NAME = "perp-arbitrageur"

// log4ts
configure({
    appenders: {
        out: { type: "stdout" },
    },
    categories: {
        default: { appenders: ["out"], level: "info" },
    },
})
