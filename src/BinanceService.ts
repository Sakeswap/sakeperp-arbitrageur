/* eslint-disable @typescript-eslint/no-explicit-any */
import { Log } from "./Log"
import { Service } from "typedi"
import Big from "big.js"
import { URL } from "url"
import axios, { Method } from "axios"
import * as CryptoJs from "crypto-js"
import { AccountInfo, CexPosition, PlaceOrderPayload, CexMarket, AuthenticationMethod } from "./Types"
import { CexService } from "./CexService"

@Service()
export class BinanceService implements CexService {
    private readonly log = Log.getLogger(BinanceService.name)
    private readonly url = "https://fapi.binance.com"
    private static API_KEY: string
    private static API_SECRET: string

    constructor(apiKey?: string, apiSecret?: string) {
        BinanceService.API_KEY = apiKey || "";
        BinanceService.API_SECRET = apiSecret || "";
    }

    async getMarket(marketName: string): Promise<CexMarket> {
        const response = await this.makeRequest(
            `${this.url}/fapi/v1/ticker/price`,
            "get",
            AuthenticationMethod.NONE,
            ["symbol", marketName]
        )
        const cexMarket = this.toCexMarket(response.data)
        return cexMarket
    }

    async getAccountInfo(client: any): Promise<AccountInfo> {
        const response = await this.makeRequest(
            `${this.url}/fapi/v2/account`,
            "get",
            AuthenticationMethod.SIGNED
        )

        let totalNotional = Big(0)
        let TotalMaintMargin = Big(0)

        const positionsMap: Record<string, CexPosition> = {}
        for (let i = 0; i < response.data.positions.length; i++) {
            const positionEntity = response.data.positions[i]
            if (Big(positionEntity.positionAmt).cmp(Big(0)) > 0) {
                totalNotional = totalNotional.add(Big(positionEntity.notional))
                TotalMaintMargin = TotalMaintMargin.add(Big(positionEntity.maintMargin))
                const position = this.toCexPosition(positionEntity)
                positionsMap[position.future] = position
            }
        }

        return {
            freeCollateral: Big(response.data.availableBalance),
            totalAccountValue: Big(response.data.totalWalletBalance).add(Big(response.data.totalUnrealizedProfit)),
            // marginFraction is null if the account has no open positions
            marginFraction: totalNotional.valueOf() == "0" ? Big(0) : Big(response.data.totalMarginBalance).div(totalNotional),
            maintenanceMarginRequirement: TotalMaintMargin,
            positionsMap: positionsMap,
        }
    }

    async getPosition(client: any, marketId: string): Promise<CexPosition> {
        const response = await this.makeRequest(
            `${this.url}/fapi/v2/account`,
            "get",
            AuthenticationMethod.SIGNED
        )

        const positions: Record<string, CexPosition> = {}
        for (let i = 0; i < response.data.positions.length; i++) {
            const positionEntity = response.data.positions[i]
            if (positionEntity.symbol === marketId) {
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
        const response = await this.makeRequest(
            `${this.url}/fapi/v2/account`,
            "get",
            AuthenticationMethod.SIGNED
        )

        const pnls: Record<string, number> = {}
        for (let i = 0; i < response.data.positions.length; i++) {
            const positionEntity = response.data.positions[i]
            if (Big(positionEntity.positionAmt).cmp(Big(0)) != 0) {
                pnls[positionEntity.symbol] = positionEntity.unrealizedProfit
            }
        }

        return pnls
    }

    async placeOrder(client: any, payload: PlaceOrderPayload): Promise<void> {
        if (payload.market == "BNBUSDT" || payload.market == "LINKUSDT") {
            payload.size = parseFloat(payload.size.toFixed(2))
        }

        await this.getServerTime()

        try {
            const response = await this.makeRequest(
                `${this.url}/fapi/v1/order`,
                "post",
                AuthenticationMethod.SIGNED,
                ["symbol", payload.market],
                ["side", payload.side],
                ["type", payload.type],
                ["quantity", payload.size]
            )

            this.log.jinfo({
                event: "PlaceOrder",
                params: response.data,
            })
        } catch (error) {
            this.log.jinfo({
                event: "PlaceOrderError",
                params: error,
            })
        }
    }

    async getServerTime(): Promise<string> {
        const response = await this.makeRequest(
            `${this.url}/fapi/v1/time`,
            "get",
            AuthenticationMethod.NONE
        )

        this.log.jinfo({
            event: "ServerTime",
            params: response.data.serverTime,
        })

        return response.data.serverTime
    }

    // noinspection JSMethodCanBeStatic
    private toCexMarket(market: any): CexMarket {
        return {
            name: market.symbol,
            last: market.price ? Big(market.price) : undefined,
        }
    }

    private toCexPosition(positionEntity: any): CexPosition {
        return {
            future: positionEntity.symbol,
            netSize: Big(positionEntity.positionAmt),
            entryPrice: Big(positionEntity.entryPrice),
            realizedPnl: Big(positionEntity.unrealizedProfit),
            cost: Big(positionEntity.cost ? positionEntity.cost : 0),
        }
    }

    private async makeRequest(
        uri: string,
        method: Method,
        requiredAuthentication: AuthenticationMethod,
        ...parameters: [string, any][]
    ): Promise<any> {
        const apiUrl: URL = new URL(uri)

        for (const parameter of parameters) {
            if (this.isNullOrUndefined(parameter[1])) {
                continue
            }
            apiUrl.searchParams.append(parameter[0], parameter[1].toString())
        }

        const headers: any = this.setupAuthentication(
            apiUrl,
            requiredAuthentication
        )

        try {
            return await axios.request({
                method: method,
                url: apiUrl.href,
                headers: headers,
            })
        } catch (error) {
            this.log.jinfo({
                event: "requestError",
                params: error,
            })
        }
    }

    /**
     * Utility method setting up the request in order to handle Binance's various
     * authentication methods.
     *
     * @param httpMethod           The HTTP method used to access the wanted resource
     *                             (mainly used for error logging purposes).
     * @param apiUrl               The URL at which the wanted resource can be accessed.
     * @param authenticationMethod The authentication method through which the wanted
     *                             resource can be accessed through the specified URL.
     */
    private setupAuthentication(
        apiUrl: URL,
        authenticationMethod: AuthenticationMethod
    ): any {
        const headers: any = {};
        if (authenticationMethod === AuthenticationMethod.NONE) {
            return
        }

        if (this.isNullOrUndefined(BinanceService.API_KEY)) {
            this.log.jinfo({
                event: "API KEY is null",
                params: BinanceService.API_KEY,
            })
            return
        }
        headers["X-MBX-APIKEY"] = BinanceService.API_KEY

        if (authenticationMethod === AuthenticationMethod.SIGNED) {
            if (this.isNullOrUndefined(BinanceService.API_SECRET)) {
                this.log.jinfo({
                    event: "API SECRET is null",
                    params: BinanceService.API_SECRET,
                })
                return
            }

            apiUrl.searchParams.append(
                "timestamp",
                new Date().getTime().toString()
            )

            apiUrl.searchParams.append(
                "signature",
                CryptoJs.HmacSHA256(
                    apiUrl.searchParams.toString(),
                    BinanceService.API_SECRET
                ).toString()
            )
        }
        return headers
    }

    private isNullOrUndefined(value: any): boolean {
        if (value === null || value === undefined) {
            return true
        }
        return false
    }
}
