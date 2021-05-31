import { AccountInfo, CexPosition, PlaceOrderPayload, CexMarket, PositionSizeMitigation } from "./Types"
import Big from "big.js"
import { Side } from "./PerpService"

export interface CexService {
    getMarket(marketName: string): Promise<CexMarket>;
    getAccountInfo(client: any): Promise<AccountInfo>;
    getPosition(client: any, marketId: string): Promise<CexPosition>;
    getTotalPnLs(client: any): Promise<Record<string, number>>;
    placeOrder(client: any, payload: PlaceOrderPayload): Promise<void>;
}

export function mitigatePositionSizeDiff(sakeperpPositionSize: Big, cexPositionSize: Big): PositionSizeMitigation {
    const cexSizeDiff = cexPositionSize.add(sakeperpPositionSize)
    let side = null
    if (cexSizeDiff.gte(Big(0))) {
        // CEX shorts too little or longs too much
        side = Side.SELL
    } else {
        // CEX shorts too much or longs too little
        side = Side.BUY
    }

    return {
        sizeAbs: cexSizeDiff.abs(),
        side,
    }
}