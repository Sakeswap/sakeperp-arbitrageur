/* eslint-disable @typescript-eslint/no-explicit-any */
import { Log } from "./Log"
import { Service } from "typedi"
import Big from "big.js"
import axios, { Method } from "axios"
import { AccountInfo, CexPosition, PlaceOrderPayload, CexMarket, AuthenticationMethod} from "./Types"
import { CexService } from "./CexService"
import HttpsProxyAgent from "https-proxy-agent"
import { URL } from "url"
import * as CryptoJs from "crypto-js"
import fetch from "node-fetch"

//test
const proxy = 'http://localhost:7890' // HTTP/HTTPS proxy to connect to
const agent = HttpsProxyAgent(proxy)

@Service()
export class OkexService implements CexService {
    private readonly log = Log.getLogger(OkexService.name)
    private readonly host = "https://www.okex.com"
    private API_Key : string
    private API_Secret : string
    private API_Password : string
    
    private accountResp: any
    private positionResp: any
    

    constructor(apiKey?: string, apiSecret?: string, apiPassword?: string) {
        this.API_Key = apiKey || "";
        this.API_Secret  = apiSecret || "";
        this.API_Password  = apiPassword || "";
    }

    //avoid too many request error
    async fetchBalance() : Promise<any> {
        try {
            this.accountResp = await this.makeRequest(
                `/api/v5/account/balance`,
                "GET",
                AuthenticationMethod.SIGNED,
                {"ccy":"USDT"}
            )
        } catch (error) {
            this.log.jerror({
                event: "Okex fetchBalance error",
                params: {
                    reason: error.toString(),
                    stackTrace: error.stack,
                },
            })
        }

        return this.accountResp
    }

    async getMarket(marketName: string): Promise<CexMarket> {
        const response = await this.makeRequest(
            `/api/v5/market/ticker`,
            "GET",
            AuthenticationMethod.SIGNED,
            {"instId": marketName}
        )

        const cexMarket = this.toCexMarket(response.data[0])
        return cexMarket
    }

    async fetchPositions() : Promise<any> {
        try {
            this.positionResp = await this.makeRequest(
                `/api/v5/account/positions`,
                "GET",
                AuthenticationMethod.SIGNED,
                {}
            )
        } catch (error) {
            this.log.jerror({
                event: "Okex fetchPositions error",
                params: {
                    reason: error.toString(),
                    stackTrace: error.stack,
                },
            })
        }

        return this.positionResp
    }

    async getAccountInfo(client: any): Promise<AccountInfo> {
        const accountResp = (await this.fetchBalance()).data
        const positionsResp = (await this.fetchPositions()).data

        let totalNotional = Big(0)
        let TotalMaintMargin = Big(0)
        let freeCollateral = Big(0)
        let totalAccountValue = Big(0)
        let totalMarginBalance = Big(0)
        let marginRatio = Big(0)

        for(let i = 0; i < accountResp.length; ++i) {
            let balanceArray = accountResp[i]["details"]
            for(let j = 0; j < balanceArray.length; ++j)
            {
                let balanceInfo = balanceArray[j]
                freeCollateral = freeCollateral.add(Big(balanceInfo["availEq"]))
                totalAccountValue = totalAccountValue.add(Big(balanceInfo["availEq"]).add(Big(balanceInfo["upl"])))
                marginRatio = balanceInfo["mgnRatio"].length > 0 ? Big(balanceInfo["mgnRatio"]) : Big(0) 
            }
        }

        const positionsMap: Record<string, CexPosition> = {}
        for (let i = 0; i < positionsResp.length; i++) {
            const positionEntity = positionsResp[i]
            if (Big(positionEntity.pos).cmp(Big(0)) > 0) {
                totalNotional = totalNotional.add(Big(positionEntity.margin).mul(Big(positionEntity.lever)))
                TotalMaintMargin = TotalMaintMargin.add(Big(positionEntity.margin))
                const position = this.toCexPosition(positionEntity)
                positionsMap[position.future] = position
            }
        }

        return {
            freeCollateral: freeCollateral,
            totalAccountValue: totalAccountValue,
            // marginFraction is null if the account has no open positions
            marginFraction: totalNotional.cmp(Big(0)) > 0 ? totalMarginBalance.div(totalNotional) : Big(0),
            maintenanceMarginRequirement: TotalMaintMargin,
            positionsMap: positionsMap,
        }
    }

    async getPosition(client: any, marketId: string): Promise<CexPosition> {
        const positionsResp = (await this.fetchPositions()).data

        const positions: Record<string, CexPosition> = {}
        for (let i = 0; i < positionsResp.length; i++) {
            const positionEntity = positionsResp[i]
            if (positionEntity.instId === marketId) {
                const position = this.toCexPosition(positionEntity)
                positions[position.future] = position

                this.log.jinfo({
                    event: "GetPositions",
                    params: positionEntity,
                })
            }
        }

        return positions[marketId]
    }

    async getTotalPnLs(client: any): Promise<Record<string, number>> {
        const positionsResp = (await this.fetchPositions()).data
        const pnls: Record<string, number> = {}
        for(let i = 0; i < positionsResp.length; ++i) {
            let info = positionsResp[i]
            pnls[info.instId] = info.upl
        }
        return pnls
    }

    async getCtVal(marketId: string) : Promise<number> {
        const response = await this.makeRequest(
            `/api/v5/public/instruments`,
            "GET",
            AuthenticationMethod.SIGNED,
            {
                "instId": marketId,
                "instType": "SWAP",
            }
        )
        return response.data[0]["ctVal"]
    }

    async placeOrder(client: any, payload: PlaceOrderPayload): Promise<void> {
        let ctVal = await this.getCtVal(payload.market)
        let sz = Math.floor(payload.size / ctVal)
        let clOrdId = (new Date()).getTime()
        let params = {
            "instId" : payload.market,
            "tdMode" : "isolated",
            "ccy" : "USDT",
            "clOrdId" : clOrdId,
            "side" : payload.side,
            "ordType" : "market",
            "sz" : sz,
            "posSide" : payload.side == "buy" ? "long" : "short" 
        }

        let response = await this.makeRequest(
            `/api/v5/trade/order`,
            "POST",
            AuthenticationMethod.SIGNED,
            params
        )

        this.log.jinfo({
            event: "PlaceOrder",
            params: response,
        })
    }

    // noinspection JSMethodCanBeStatic
    private toCexMarket(market: any): CexMarket {
        return {
            name: market.instrument_id,
            last: Big(market.last),
        }
    }

    private toCexPosition(positionEntity: any): CexPosition {
        return {
            future: positionEntity.instrument_id,
            netSize: Big(positionEntity.position),
            entryPrice: Big(positionEntity.avg_cost),
            realizedPnl: Big(positionEntity.unrealized_pnl),
            cost: Big(positionEntity.avg_cost * positionEntity.position),
        }
    }

    private async makeRequest(
        uri: string,
        method: Method,
        requiredAuthentication: AuthenticationMethod,
        parameters: any
    ): Promise<any> {
        let apiUrl = `${this.host}${uri}`;

        let options = {};
        if (requiredAuthentication === AuthenticationMethod.SIGNED) {
            if(method == "GET")
            {
                let url = uri
                let paramKeys = Object.keys(parameters)
                for (let index = 0; index < paramKeys.length; index++) {
                    if (index === 0) {
                        url += `?${paramKeys[index]}=${parameters[paramKeys[index]]}`
                    }
                    else {
                        url += `&${paramKeys[index]}=${parameters[paramKeys[index]]}`
                    }
                }
                const timestamp = new Date().toISOString()
                const dirUrl = url.replace(/.*\/\/[^\/]*/, '')
                apiUrl = `${this.host}${dirUrl}`
                let sign = CryptoJs.enc.Base64.stringify(CryptoJs.HmacSHA256(timestamp + 'GET' + dirUrl, this.API_Secret))

                options = {
                    method: 'get',
                    headers: {
                        'OK-ACCESS-KEY': this.API_Key,
                        'OK-ACCESS-SIGN': sign,
                        'OK-ACCESS-TIMESTAMP': timestamp,
                        'OK-ACCESS-PASSPHRASE': this.API_Password,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'x-simulated-trading': '1'
                    },
                    agent: agent
                }
            }
            else if(method == "POST")
            {
                const jsonValue = JSON.stringify(parameters)
                const timestamp = new Date().toISOString()
                const dirUrl = uri.replace(/.*\/\/[^\/]*/, '')
                let sign = CryptoJs.enc.Base64.stringify(CryptoJs.HmacSHA256(timestamp + 'POST' + dirUrl + jsonValue, this.API_Secret))
                options = {
                    method: 'post',
                    body: JSON.stringify(parameters),
                    headers: {
                        'OK-ACCESS-KEY': this.API_Key,
                        'OK-ACCESS-SIGN': sign,
                        'OK-ACCESS-TIMESTAMP': timestamp,
                        'OK-ACCESS-PASSPHRASE': this.API_Password,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'x-simulated-trading': '1'
                    },
                    agent: agent
                }
            }
        }

        try {
            const response = await fetch(
                apiUrl, 
                options
            );
            this.log.jinfo({
                event: "response",
                params: response.status,
            }) 
            return await response.json();   
        } catch (error) {
            this.log.jinfo({
                event: "requestError",
                params: error,
            })
        }
    }
}
