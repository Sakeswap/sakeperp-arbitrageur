import { Service } from "typedi"
import configJson from '../config/config.json';
import Big from "big.js"

@Service()
export class ConfigHelper {
    constructor() {
    }

    parseConfigFile(): [ PreflightCheck,  Record<string, ExchangeConfig>]{
        let preflightCheck: PreflightCheck = {
            BLOCK_TIMESTAMP_FRESHNESS_THRESHOLD: configJson.PreflightCheck.BLOCK_TIMESTAMP_FRESHNESS_THRESHOLD,
            GAS_BALANCE_THRESHOLD: Big(configJson.PreflightCheck.GAS_BALANCE_THRESHOLD),
            USD_BALANCE_THRESHOLD: Big(configJson.PreflightCheck.USD_BALANCE_THRESHOLD),
            CEX_USD_BALANCE_THRESHOLD: Big(configJson.PreflightCheck.CEX_USD_BALANCE_THRESHOLD),
            CEX_MARGIN_RATIO_THRESHOLD: Big(configJson.PreflightCheck.CEX_MARGIN_RATIO_THRESHOLD),
            CEX_LIQUIDATION_RATIO: Big(configJson.PreflightCheck.CEX_LIQUIDATION_RATIO)
        }

        let exchangeConfigMap:  Record<string, ExchangeConfig>  = {}
        configJson.ExchangeConfig.forEach((value , index) =>{
            let pair = value.Pair
            let eConfig: ExchangeConfig = {
                ENABLED: value.ENABLED,
                ASSET_CAP: Big(value.ASSET_CAP),
                SAKEPERP_LEVERAGE: Big(value.SAKEPERP_LEVERAGE),
                SAKEPERP_MIN_TRADE_NOTIONAL: Big(value.SAKEPERP_MIN_TRADE_NOTIONAL),
                SAKEPERP_LONG_ENTRY_TRIGGER: Big(value.SAKEPERP_LONG_ENTRY_TRIGGER), 
                SAKEPERP_LONG_CLOSE_TRIGGER: Big(value.SAKEPERP_LONG_CLOSE_TRIGGER), 
                SAKEPERP_LONG_OPEN_PRICE_SPREAD: Big(value.SAKEPERP_LONG_OPEN_PRICE_SPREAD), 
                SAKEPERP_SHORT_ENTRY_TRIGGER: Big(value.SAKEPERP_SHORT_ENTRY_TRIGGER),
                SAKEPERP_SHORT_CLOSE_TRIGGER: Big(value.SAKEPERP_SHORT_CLOSE_TRIGGER),
                SAKEPERP_SHORT_OPEN_PRICE_SPREAD: Big(value.SAKEPERP_SHORT_OPEN_PRICE_SPREAD),
                ADJUST_MARGIN_RATIO_THRESHOLD: Big(value.ADJUST_MARGIN_RATIO_THRESHOLD),
                MAX_SLIPPAGE_RATIO: Big(value.MAX_SLIPPAGE_RATIO),
                CEX_MARKET_ID: value.CEX_MARKET_ID,
                CEX_MIN_TRADE_SIZE: Big(value.CEX_MIN_TRADE_SIZE), 
            }
            exchangeConfigMap[pair] = eConfig
        })
        return [preflightCheck,  exchangeConfigMap]
    }
}

export interface ExchangeConfig {
    ENABLED: boolean
    ASSET_CAP: Big
    SAKEPERP_LEVERAGE: Big
    SAKEPERP_MIN_TRADE_NOTIONAL: Big
    SAKEPERP_LONG_ENTRY_TRIGGER: Big
    SAKEPERP_LONG_CLOSE_TRIGGER: Big
    SAKEPERP_LONG_OPEN_PRICE_SPREAD: Big
    SAKEPERP_SHORT_ENTRY_TRIGGER: Big
    SAKEPERP_SHORT_CLOSE_TRIGGER: Big
    SAKEPERP_SHORT_OPEN_PRICE_SPREAD: Big
    ADJUST_MARGIN_RATIO_THRESHOLD: Big
    MAX_SLIPPAGE_RATIO: Big
    CEX_MARKET_ID: string
    CEX_MIN_TRADE_SIZE: Big
}

export interface PreflightCheck  {
    BLOCK_TIMESTAMP_FRESHNESS_THRESHOLD: number
    GAS_BALANCE_THRESHOLD: Big
    USD_BALANCE_THRESHOLD: Big
    CEX_USD_BALANCE_THRESHOLD: Big
    CEX_MARGIN_RATIO_THRESHOLD: Big
    CEX_LIQUIDATION_RATIO: Big
}

