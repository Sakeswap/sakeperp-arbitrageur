import { Log } from "./Log"
import { ServerProfile } from "./ServerProfile"
import { Service } from "typedi"
import fetch from "node-fetch"

@Service()
export class SystemMetadataFactory {
    private ethMetadata!: EthMetadata
    private fetchUrl = "https://bsc-graphnode-api.sakeperp.fi/subgraphs/name/sakeperp/sakeperp-subgraph"
    // private fetchUrl = "https://bsctest-graphnode-api.sakeperp.fi/subgraphs/name/sakeperp/sakeperp-subgraph-v2"

    constructor(readonly serverProfile: ServerProfile) { }

    async fetch(): Promise<EthMetadata> {
        if (!this.ethMetadata) {
            this.ethMetadata = await this._fetch()
        }
        return this.ethMetadata
    }

    private async _fetch(): Promise<EthMetadata> {
        const systemMetadata = await this.getSystemMetadata()
        return this.toEthMetadata(systemMetadata)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async getSystemMetadata(): Promise<any> {
        return await fetch(this.fetchUrl, { method: 'POST', body: '{"query": "{contractLists {name addr}}"}' }).then(res => res.json())
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private toEthMetadata(system: SystemMetadata): EthMetadata {
        const contracts = system.data.contractLists
        let systemSettingsAddr = ""
        let exchangeReaderAddr = ""
        let sakePerpAddr = ""
        let sakePerpViewerAddr = ""
        let sakePerpStateAddr = ""

        for (let i = 0; i < contracts.length; i++) {
            if (contracts[i].name == "SakePerp") {
                sakePerpAddr = contracts[i].addr
            } else if (contracts[i].name == "SystemSettings") {
                systemSettingsAddr = contracts[i].addr
            } else if (contracts[i].name == "SakePerpViewer") {
                sakePerpViewerAddr = contracts[i].addr
            } else if (contracts[i].name == "ExchangeReader") {
                exchangeReaderAddr = contracts[i].addr
            }else if  (contracts[i].name == "SakePerpState") {
                sakePerpStateAddr = contracts[i].addr 
            }
        }

        return {
            systemSettingsAddr: systemSettingsAddr,
            exchangeReaderAddr: exchangeReaderAddr,
            sakePerpAddr: sakePerpAddr,
            sakePerpViewerAddr: sakePerpViewerAddr,
            sakePerpStateAddr: sakePerpStateAddr 
        }
    }
}

export interface ContractMetadata {
    name: string
    addr: string
    isExchange: boolean
}

export interface SystemMetadata {
    data: {
        contractLists: ContractMetadata[]
    }
}

export interface EthMetadata {
    readonly systemSettingsAddr: string
    readonly exchangeReaderAddr: string
    readonly sakePerpAddr: string
    readonly sakePerpViewerAddr: string
    readonly sakePerpStateAddr: string
}
