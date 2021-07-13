import Big from "big.js"
import { Side } from "./PerpService"

export interface AccountInfo {
    freeCollateral: Big
    totalAccountValue: Big
    marginFraction: Big
    maintenanceMarginRequirement: Big
    positionsMap: Record<string, CexPosition>
}

export interface CexPosition {
    future: string
    netSize: Big // + is long and - is short
    entryPrice: Big
    realizedPnl: Big
    cost: Big
}

export interface PlaceOrderPayload {
    market: string
    side: string
    price: null
    size: number
    type: string
    leverage: Big
}

export interface PositionSizeMitigation {
    sizeAbs: Big
    side: Side
}

export interface CexMarket {
    name: string
    last?: Big
}


export interface CexPositionRisk {
    markPrice: Big
    liquidationPrice: Big
}


export enum AuthenticationMethod {
    NONE,
    API_KEY,
    SIGNED,
}

