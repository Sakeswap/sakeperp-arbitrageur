/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Service } from "typedi"
import { Log } from "./Log"

@Service()
export class ServerProfile {
    private readonly log = Log.getLogger(ServerProfile.name)
    readonly web3Endpoint: string
    readonly arbitrageurPK: string
    readonly cexApiKey: string
    readonly cexApiSecret: string
    readonly cexApiPassword: string
    readonly cexSubaccount: string | undefined
    readonly cexPlatform: string

    constructor() {

        this.web3Endpoint = process.env.WEB3_ENDPOINT!
        this.arbitrageurPK = process.env.ARBITRAGEUR_PK!
        this.cexApiKey = process.env.CEX_API_KEY!
        this.cexApiSecret = process.env.CEX_API_SECRET!
        this.cexApiPassword = process.env.CEX_API_PASSWORD!
        this.cexSubaccount = process.env.CEX_SUBACCOUNT
        this.cexPlatform = process.env.CEX_PLATFORM!

        this.log.jinfo({
            event: "ServerProfile",
            params: {
                web3Endpoint: this.web3Endpoint,
            }
        })
    }
}
