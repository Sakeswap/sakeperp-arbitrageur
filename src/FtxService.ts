/* eslint-disable @typescript-eslint/no-explicit-any */
import { Log } from "./Log"
import { Service } from "typedi"
import Big from "big.js"
import fetch from "node-fetch"
import { CexService } from "./CexService"
import { AccountInfo, CexPosition, PlaceOrderPayload, CexMarket } from "./Types"

@Service()
export class FtxService implements CexService {
    private readonly log = Log.getLogger(FtxService.name)

    async getMarket(marketName: string): Promise<CexMarket> {
        const response = await fetch(`https://ftx.com/api/markets/${marketName}`)
        const result: any[] = (await response.json()).result
        const cexMarket = this.toCexMarket(result)
        return cexMarket
    }

    async getAccountInfo(ftxClient: any): Promise<AccountInfo> {
        const data = await ftxClient.request({
            method: "GET",
            path: "/account",
        })
        this.log.jinfo({
            event: "GetAccountInfo",
            params: data,
        })

        const positionsMap: Record<string, CexPosition> = {}
        for (let i = 0; i < data.result.positions.length; i++) {
            const positionEntity = data.result.positions[i]
            const position = this.toCexPosition(positionEntity)
            positionsMap[position.future] = position
        }

        return {
            freeCollateral: Big(data.result.freeCollateral),
            totalAccountValue: Big(data.result.totalAccountValue),
            // marginFraction is null if the account has no open positions
            marginFraction: Big(data.result.marginFraction ? data.result.marginFraction : 0),
            maintenanceMarginRequirement: Big(data.result.maintenanceMarginRequirement),
            positionsMap: positionsMap,
        }
    }

    async getPosition(ftxClient: any, marketId: string): Promise<CexPosition> {
        const data = await ftxClient.request({
            method: "GET",
            path: "/positions",
        })
        this.log.jinfo({
            event: "GetPositions",
            params: data,
        })
        const positions: Record<string, CexPosition> = {}
        for (let i = 0; i < data.result.length; i++) {
            const positionEntity = data.result[i]
            if (positionEntity.future === marketId) {
                const position = this.toCexPosition(positionEntity)
                positions[position.future] = position
            }
        }
        return positions[marketId]
    }

    async getTotalPnLs(ftxClient: any): Promise<Record<string, number>> {
        const data = await ftxClient.request({
            method: "GET",
            path: "/pnl/historical_changes",
        })
        return data.result.totalPnl
    }

    async placeOrder(ftxClient: any, payload: PlaceOrderPayload): Promise<void> {
        const data = await ftxClient.request({
            method: "POST",
            path: "/orders",
            data: payload,
        })
        this.log.jinfo({
            event: "PlaceOrder",
            params: data,
        })
    }

    // noinspection JSMethodCanBeStatic
    private toCexMarket(market: any): CexMarket {
        return {
            name: market.name,
            last: market.last ? Big(market.last) : undefined,
        }
    }

    private toCexPosition(positionEntity: any): CexPosition {
        return {
            future: positionEntity.future,
            netSize: Big(positionEntity.netSize),
            entryPrice: Big(positionEntity.entryPrice ? positionEntity.entryPrice : 0),
            realizedPnl: Big(positionEntity.realizedPnl ? positionEntity.realizedPnl : 0),
            cost: Big(positionEntity.cost ? positionEntity.cost : 0),
        }
    }
}
