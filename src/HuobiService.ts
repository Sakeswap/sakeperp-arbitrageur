/* eslint-disable @typescript-eslint/no-explicit-any */
import { Log } from "./Log"
import { Service } from "typedi"
import Big from "big.js"
import fetch from "node-fetch"
import { URL } from "url"
import * as CryptoJs from "crypto-js"
import axios, { Method } from "axios"
import { AccountInfo, CexPosition, PlaceOrderPayload, CexMarket, AuthenticationMethod } from "./Types"

@Service()
export class HuobiService {
    private readonly log = Log.getLogger(HuobiService.name)
    private readonly host = "https://api.btcgateway.pro"
    private readonly urlPrefix = "/linear-swap-api/v1"
    private readonly order_type = "optimal_10"
    private static API_Access_Key : string
    private static API_Secret_Key : string

    constructor(apiKey?: string, apiSecret?: string) {
        HuobiService.API_Access_Key = apiKey || "";
        HuobiService.API_Secret_Key  = apiSecret || "";
    }

    async getMarket(marketName: string): Promise<CexMarket> { 
        const info = await this.makeRequest(
            `${this.urlPrefix}/swap_index/?contract_code=${marketName}`,
            "get",
            AuthenticationMethod.NONE,
        )

        return {
            name: marketName,
            last: info.data ? Big(info.data[0].index_price) : undefined,
        }    
    }

    async getAccountInfo(client: any): Promise<AccountInfo> {
        const accountInfo = await this.makeRequest(
            `${this.urlPrefix}/swap_cross_account_info`,
            "post",
            AuthenticationMethod.SIGNED,
        )
        const positionInfo = await this.makeRequest(
            `${this.urlPrefix}/swap_cross_position_info`,
            "post",
            AuthenticationMethod.SIGNED,
        )

        // this.log.jinfo({
        //     event: "accountInfo",
        //     params: accountInfo,
        // })

        // this.log.jinfo({
        //     event: "positionInfo",
        //     params: positionInfo,
        // })

        let totalNotional = Big(0)
        let TotalMaintMargin = Big(0)
        const positionsMap: Record<string, CexPosition> = {}
        for (let i = 0; i < positionInfo.data.length; i++) {
            const positionEntity = positionInfo.data[i]
            if (Big(positionEntity.volume).cmp(Big(0)) > 0) {
                const contract = await this.makeRequest(
                    `${this.urlPrefix}/swap_contract_info?contract_code=${positionEntity.contract_code}`,
                    "GET",
                    AuthenticationMethod.NONE
                )
 
                totalNotional = totalNotional.add(Big(positionEntity.volume).mul(Big(contract.data[0].contract_size)).mul(Big( positionEntity.last_price)))
                TotalMaintMargin = TotalMaintMargin.add(Big(positionEntity.position_margin))
                const position = this.toCexPosition(positionEntity, Big(contract.data[0].contract_size))
                positionsMap[position.future] = position
            }
        } 
       
        return {
            freeCollateral: Big(accountInfo.data[0].withdraw_available),          
            totalAccountValue:  Big(accountInfo.data[0].margin_balance),    
            // marginFraction is null if the account has no open positions    
            marginFraction: Big(!totalNotional.eq(Big(0)) ? Big(accountInfo.data[0].margin_position).div(totalNotional) : 0),
            maintenanceMarginRequirement: TotalMaintMargin, 
            positionsMap: positionsMap,
        }
    }


    async getPosition(ftxClient: any, marketId: string): Promise<CexPosition> {
        const positionInfo = await this.makeRequest(
            `${this.urlPrefix}/swap_cross_position_info`,
            "post",
            AuthenticationMethod.SIGNED,
        )

        const positions: Record<string, CexPosition> = {}
        let positionCount = 0
        for (let i = 0; i < positionInfo.data.length; i++) {
            const positionEntity = positionInfo.data[i]
            if (positionEntity.contract_code === marketId) {
                const contract = await this.makeRequest(
                    `${this.urlPrefix}/swap_contract_info?contract_code=${positionEntity.contract_code}`,
                    "GET",
                    AuthenticationMethod.NONE
                )        
                const position = this.toCexPosition(positionEntity, Big(contract.data[0].contract_size))
                if (position.netSize.abs().gt(0)){
                    positions[position.future] = position
                    this.log.jinfo({
                        event: "huobiPositon",
                        params: {
                            position: positionEntity,
                        },
                    })
                    positionCount = positionCount + 1
                }
            }
        }

        this.log.jinfo({
            event: "PositionCount",
            params: {
                marketId: marketId, 
                positionCount: positionCount,
            },
        }) 

        if (positionCount > 1) {
            await this.prePosition(marketId)
            const nilPositions: Record<string, CexPosition> = {} 
            return nilPositions[marketId] 
        }else{
            return positions[marketId]
        }
    }

    private async prePosition (marketId: string): Promise<void> {
        const positionInfo = await this.makeRequest(
            `${this.urlPrefix}/swap_cross_position_info`,
            "post",
            AuthenticationMethod.SIGNED,
        )

        for (let i = 0; i < positionInfo.data.length; i++) {
            const positionEntity = positionInfo.data[i]
            if (positionEntity.contract_code === marketId) {
                let direction = "sell"
                if (positionEntity.direction == "sell") {
                    direction = "buy"
                } 

                const closePlaceOrder: HuobiLightningPlaceOrder = {
                    contract_code: marketId,
                    direction: direction,
                    volume: positionEntity.available,
                } 
    
                this.log.jinfo({
                    event: "ClosePrePositionLightning",
                    params: {
                        closePlaceOrder: closePlaceOrder,
                    },
                }) 

                const closeData = await this.makeRequest(
                    `${this.urlPrefix}/swap_cross_lightning_close_position`,
                    "post",
                    AuthenticationMethod.SIGNED,
                    closePlaceOrder
                )
                
                this.log.jinfo({
                    event: "ClosePrePositionLightningOrder",
                    params: {
                        position: closeData,
                    },
                })

            }
        }
    }


    async getTotalPnLs(ftxClient: any): Promise<Record<string, number>> {
        const positionInfo = await this.makeRequest(
            `${this.urlPrefix}/swap_cross_position_info`,
            "post",
            AuthenticationMethod.SIGNED,
        )

        const pnls: Record<string, number> = {}
        for (let i = 0; i < positionInfo.data.length; i++) {
            const positionEntity = positionInfo.data[i]
            if (Big(positionEntity.volume).cmp(Big(0)) > 0) {
                pnls[positionEntity.contract_code] = positionEntity.profit_unreal
            }
        }
        return pnls
    }


    async placeOrder(ftxClient: any, payload: PlaceOrderPayload): Promise<void> {
        const contract = await this.makeRequest(
            `${this.urlPrefix}/swap_contract_info?contract_code=${payload.market}`,
            "GET",
            AuthenticationMethod.NONE
        )

        const currentPosition = await this.getPosition(null, payload.market)
        let currentNetSize = Big(0);
        if (currentPosition){
            currentNetSize = currentPosition.netSize 
            if (currentNetSize.gt(0) && payload.side == "sell"){
                await this.placeOrderBuy(payload, currentNetSize, Big(contract.data[0].contract_size))
                return  
            }

            if (currentNetSize.lt(0)  && payload.side == "buy"){
                await this.placeOrderSell(payload, currentNetSize, Big(contract.data[0].contract_size))
                return  
            }
        }

        let volume = Big(payload.size).div(Big(contract.data[0].contract_size)).toFixed(3)

        if (parseInt(volume) == 0){
            return
        } 

        const placeOrder: HuobiPlaceOrder = {
            contract_code: payload.market,
            direction: payload.side,
            offset: "open",
            volume: parseInt(volume),
            lever_rate: payload.leverage,
            // type: payload.type,
            order_price_type: this.order_type,
        }

        this.log.jinfo({
            event: "OpenPosition",
            params: {
                payload: payload,
                currentNetSize: currentNetSize,
                contract_size: contract.data[0].contract_size,
                volume: volume,
                volumeInt: parseInt(volume),
            },
        }) 


        const data = await this.makeRequest(
            `${this.urlPrefix}/swap_cross_order`,
            "post",
            AuthenticationMethod.SIGNED,
            placeOrder
        )
        
        this.log.jinfo({
            event: "OpenPositionOrder",
            params: data,
        })

        // const newestPosition = await this.getPosition(NOT_IMPLEMENTED, payload.market)
        // this.log.jinfo({
        //     event: "NewestPosition",
        //     params: newestPosition,
        // })
    }


    // current is buy position, payload is sell
    private async placeOrderBuy( payload: PlaceOrderPayload, currentNetSize: Big, contract_size: Big) {
        if (currentNetSize.abs().gte(payload.size)){
            let closeVolume = Big(payload.size).div(contract_size).toFixed(3)
            const closePlaceOrder: HuobiPlaceOrder = {
                contract_code: payload.market,
                direction: "sell",
                offset: "close",
                volume: parseInt(closeVolume),
                lever_rate: payload.leverage,
                // type: payload.type,
                order_price_type: this.order_type,
            }
                        
            this.log.jinfo({
                event: "CloseBuyPosition",
                params: {
                    payload: payload,
                    currentNetSize: currentNetSize,
                    contract_size: contract_size,
                    volume: closeVolume,
                    volumeInt: parseInt(closeVolume),
                },
            }) 

            const data = await this.makeRequest(
                `${this.urlPrefix}/swap_cross_order`,
                "post",
                AuthenticationMethod.SIGNED,
                closePlaceOrder
            )
            
            this.log.jinfo({
                event: "CloseBuyPositionOrder",
                params: data,
            }) 

        }else{
            let closeVolume = Big(currentNetSize.abs()).div(contract_size).toFixed(3)
            const closePlaceOrder: HuobiLightningPlaceOrder = {
                contract_code: payload.market,
                direction: "sell",
                volume: parseInt(closeVolume),
            } 

            this.log.jinfo({
                event: "CloseBuyPositionLightning",
                params: {
                    payload: payload,
                    currentNetSize: currentNetSize,
                    contract_size: contract_size,
                    volume: closeVolume,
                    volumeInt: parseInt(closeVolume),
                },
            }) 

            const closeData = await this.makeRequest(
                `${this.urlPrefix}/swap_cross_lightning_close_position`,
                "post",
                AuthenticationMethod.SIGNED,
                closePlaceOrder
            )
            
            this.log.jinfo({
                event: "CloseBuyPositionLightningOrder",
                params: closeData,
            }) 

            let openSize = Big(payload.size).sub(currentNetSize.abs()) 
            let openVolume =  openSize.div(contract_size).toFixed(3)
            
            const openPlaceOrder: HuobiPlaceOrder = {
                contract_code: payload.market,
                direction: "sell",
                offset: "open",
                volume: parseInt(openVolume),
                lever_rate: payload.leverage,
                order_price_type: this.order_type,
            }

            this.log.jinfo({
                event: "OpenSellPosition",
                params: {
                    payload: payload,
                    contract_size: contract_size,
                    volume: closeVolume,
                    volumeInt: parseInt(closeVolume),
                },
            }) 


            const openData = await this.makeRequest(
                `${this.urlPrefix}/swap_cross_order`,
                "post",
                AuthenticationMethod.SIGNED,
                openPlaceOrder
            )
            
            this.log.jinfo({
                event: "OpenSellPositionOrder",
                params: openData,
            }) 

        }
    } 


    // current is sell position, payload is buy
    private async placeOrderSell( payload: PlaceOrderPayload, currentNetSize: Big, contract_size: Big) {
        if (currentNetSize.abs().gte(payload.size)){
            let closeVolume = Big(payload.size).div(contract_size).toFixed(3)
            const closePlaceOrder: HuobiPlaceOrder = {
                contract_code: payload.market,
                direction: "buy",
                offset: "close",
                volume: parseInt(closeVolume),
                lever_rate: payload.leverage,
                // type: payload.type,
                order_price_type: this.order_type,
            }
                        
            this.log.jinfo({
                event: "CloseSellPosition",
                params: {
                    payload: payload,
                    currentNetSize: currentNetSize,
                    contract_size: contract_size,
                    volume: closeVolume,
                    volumeInt: parseInt(closeVolume),
                },
            }) 

            const data = await this.makeRequest(
                `${this.urlPrefix}/swap_cross_order`,
                "post",
                AuthenticationMethod.SIGNED,
                closePlaceOrder
            )
            
            this.log.jinfo({
                event: "CloseSellPositionOrder",
                params: data,
            })

        }else{
            let closeVolume = Big(currentNetSize.abs()).div(contract_size).toFixed(3)
            const closePlaceOrder: HuobiLightningPlaceOrder = {
                contract_code: payload.market,
                direction: "buy",
                volume: parseInt(closeVolume),
            } 

            this.log.jinfo({
                event: "CloseSellPositionLightning",
                params: {
                    payload: payload,
                    currentNetSize: currentNetSize,
                    contract_size: contract_size,
                    volume: closeVolume,
                    volumeInt: parseInt(closeVolume),
                },
            }) 

            const closeData = await this.makeRequest(
                `${this.urlPrefix}/swap_cross_lightning_close_position`,
                "post",
                AuthenticationMethod.SIGNED,
                closePlaceOrder
            )
            
            this.log.jinfo({
                event: "CloseSellPositionLightningOrder",
                params: closeData,
            }) 

            let openSize = Big(payload.size).sub(currentNetSize.abs()) 
            let openVolume =  openSize.div(contract_size).toFixed(3)
            
            const openPlaceOrder: HuobiPlaceOrder = {
                contract_code: payload.market,
                direction: "buy",
                offset: "open",
                volume: parseInt(openVolume),
                lever_rate: payload.leverage,
                order_price_type: this.order_type,
            }

            this.log.jinfo({
                event: "OpenBuyPosition",
                params: {
                    payload: payload,
                    contract_size: contract_size,
                    volume: closeVolume,
                    volumeInt: parseInt(closeVolume),
                },
            }) 


            const openData = await this.makeRequest(
                `${this.urlPrefix}/swap_cross_order`,
                "post",
                AuthenticationMethod.SIGNED,
                openPlaceOrder
            )
            
            this.log.jinfo({
                event: "OpenBuyPositionOrder",
                params: openData,
            }) 
        }
    } 



    private async makeRequest(
        uri: string,
        method: Method,
        requiredAuthentication: AuthenticationMethod,
        payload?: any
    ): Promise<any> {
        let apiUrl = `${this.host}${uri}`;
        if (requiredAuthentication == AuthenticationMethod.SIGNED){
            let timestamp = new Date().toISOString().slice(0, 19);
            let paramsMap = new Map()
            paramsMap.set("AccessKeyId", HuobiService.API_Access_Key);
            paramsMap.set("SignatureMethod", "HmacSHA256");
            paramsMap.set("SignatureVersion", 2);
            paramsMap.set("Timestamp", encodeURIComponent(timestamp));

            let paramsLists: any[] = [];
            for (let [key, value] of paramsMap) {
                paramsLists.push(key + "=" +value);         
            }

            let paramsStr = paramsLists.join("&") 

            const urlObject: URL = new URL(this.host);
            let signLists: any[] = []; 
            signLists.push(method.toUpperCase());
            signLists.push(urlObject.hostname);
            signLists.push(uri);
            signLists.push(paramsStr)
            let signBytes = CryptoJs.HmacSHA256(signLists.join("\n"), HuobiService.API_Secret_Key)
            let signStr = encodeURIComponent(CryptoJs.enc.Base64.stringify(signBytes));
            apiUrl =  `${this.host}${uri}?${paramsStr}&Signature=${signStr}` 
        }
        let body ;
        if (payload != undefined){
            body = JSON.stringify(payload) 
        }
        try {
            const response = await fetch(apiUrl, {
                method:  method,
                headers: {
                    "Content-type": "application/json; charset=UTF-8",
                },
                body: body,
            });
            return await response.json();   
        } catch (error) {
            this.log.jinfo({
                event: "requestError",
                params: error,
            })
        } 
    }

    private toCexPosition(positionEntity: any, contract_size: Big): CexPosition {
        let size = positionEntity.available
        if  (positionEntity.direction == "sell"){
            size = Big(size).mul(-1)
        } 
        return {
            future: positionEntity.contract_code,        
            netSize: Big(size).mul(contract_size),         
            entryPrice: Big(positionEntity.cost_open ? positionEntity.cost_open : 0),
            realizedPnl: Big(positionEntity.profit_unreal ? positionEntity.profit_unreal : 0),  
            cost: Big(positionEntity.cost_open * size),   
        }
    }
}

export interface HuobiAccountInfo {
    margin_account: string
}

export interface HuobiPlaceOrder {
    contract_code: string
    direction: string
    offset: string
    volume: number
    lever_rate: Big
    // type: string
    order_price_type: string
}


export interface HuobiLightningPlaceOrder {
    contract_code: string
    direction: string
    volume: number
}
