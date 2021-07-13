import {  Exchange } from "../types/ethers/Exchange"
import {  ExchangeReader} from "../types/ethers/ExchangeReader"
import { SakePerpState } from "../types/ethers/SakePerpState"
import { SakePerp } from "../types/ethers/SakePerp"
import {  SakePerpViewer } from "../types/ethers/SakePerpViewer"
import {  SystemSettings } from "../types/ethers/SystemSettings"

import { BigNumber } from "@ethersproject/bignumber"
import { ethers, Wallet } from "ethers"
import { EthMetadata, SystemMetadataFactory } from "./SystemMetadataFactory"
import { EthService } from "./EthService"
import { formatEther, parseEther } from "@ethersproject/units"
import { Log } from "./Log"
import { Overrides } from "@ethersproject/contracts"
import { ServerProfile } from "./ServerProfile"
import { Service } from "typedi"
import Big from "big.js"
import { TransactionResponse } from "@ethersproject/abstract-provider"
import ExchangeArtifact from "@sakeperp/artifact/src/Exchange.json"
import ExchangeReaderArtifact from "@sakeperp/artifact/src/ExchangeReader.json"
import SakePerpArtifact from "@sakeperp/artifact/src/SakePerp.json"
import SakePerpStateArtifact from "@sakeperp/artifact/src/SakePerpState.json"
import SakePerpViewerArtifact from "@sakeperp/artifact/src/SakePerpViewer.json"
import SystemSettingsArtifact from "@sakeperp/artifact/src/SystemSettings.json"

export enum Side {
    BUY,
    SELL,
}

export enum PnlCalcOption {
    SPOT_PRICE,
    TWAP,
}

export interface Decimal {
    d: BigNumber
}

export interface ExchangeProps {
    priceFeedKey: string
    quoteAssetSymbol: string
    baseAssetSymbol: string
    baseAssetReserve: Big
    quoteAssetReserve: Big
}

export interface Position {
    size: Big
    margin: Big
    openNotional: Big
    lastUpdatedCumulativePremiumFraction: Big
}

export interface PositionCost {
    side: Side
    size: Big
    baseAssetReserve: Big
    quoteAssetReserve: Big
}

@Service()
export class PerpService {
    private readonly log = Log.getLogger(PerpService.name)

    constructor(
        readonly ethService: EthService,
        readonly systemMetadataFactory: SystemMetadataFactory,
        readonly serverProfile: ServerProfile,
    ) {}

    private async createSystemSettings(): Promise<SystemSettings> {
        return await this.createContract<SystemSettings>(
            ethMetadata => ethMetadata.systemSettingsAddr,
            SystemSettingsArtifact,
        )
    }

    private createExchange(exchangeAddr: string): Exchange {
        return this.ethService.createContract<Exchange>(exchangeAddr, ExchangeArtifact)
    }

    private async createExchangeReader(): Promise<ExchangeReader> {
        return this.createContract<ExchangeReader>(systemMetadata => systemMetadata.exchangeReaderAddr, ExchangeReaderArtifact)
    }

    private async createSakePerp(signer?: ethers.Signer): Promise<SakePerp> {
        return this.createContract<SakePerp>(
            systemMetadata => systemMetadata.sakePerpAddr,
            SakePerpArtifact,
            signer,
        )
    }

    private async createSakePerpViewer(signer?: ethers.Signer): Promise<SakePerpViewer> {
        return this.createContract<SakePerpViewer>(
            systemMetadata => systemMetadata.sakePerpViewerAddr,
            SakePerpViewerArtifact,
            signer,
        )
    }

    private async createSakePerpState(signer?: ethers.Signer): Promise<SakePerpState> {
        return this.createContract<SakePerpState>(
            systemMetadata => systemMetadata.sakePerpStateAddr,
            SakePerpStateArtifact,
            signer,
         )
    }


    async checkWaitingPeriod(trader: Wallet, exchangeAddr: string, traderAddr: string, side: Side ): Promise<boolean> {
        const sakePerpState = await this.createSakePerpState(trader)

        const whiteList = await sakePerpState.functions.waitingWhitelist(traderAddr)
        const isWhiteAddr = whiteList[0]
        if (isWhiteAddr){
            return true
        }

        const result = await sakePerpState.functions.tradingState(exchangeAddr, traderAddr)

        const lastestLongTime = result[0].toNumber()
        const lastestShortTime = result[1].toNumber()
        const nowTime = Math.floor(Date.now() / 1000)
        const waitingPeriodSecs = 360;

        if (side == Side.BUY) {
            this.log.jinfo({
                event: "CheckWaitingPeriod",
                params: {
                    side: "buy",
                    lastestShortTime: lastestShortTime,
                    nowTime: nowTime,
                    canOpen: !(lastestShortTime + waitingPeriodSecs > nowTime)
                },
            })
            if (lastestShortTime + waitingPeriodSecs > nowTime) {
                return false
            }
        }else{
            this.log.jinfo({
                event: "CheckWaitingPeriod",
                params: {
                    side: "sell",
                    lastestLongTime: lastestLongTime,
                    nowTime: nowTime,
                    canOpen: !(lastestLongTime + waitingPeriodSecs > nowTime) 
                },
            })
            if (lastestLongTime + waitingPeriodSecs > nowTime) {
                return false
            }
        }
        return true
    }


    private async createContract<T>(
        addressGetter: (systemMetadata: EthMetadata) => string,
        abi: ethers.ContractInterface,
        signer?: ethers.Signer,
    ): Promise<T> {
        const systemMetadata = await this.systemMetadataFactory.fetch()
        return this.ethService.createContract<T>(addressGetter(systemMetadata), abi, signer)
    }

    async getAllOpenExchanges(): Promise<Exchange[]> {
        const exchanges: Exchange[] = []
        const systemSettings = await this.createSystemSettings()
        const allExchanges = await systemSettings.functions.getAllExchanges()
        for (const exchangeAddr of allExchanges[0]) {
            const exchange = this.createExchange(exchangeAddr)
            if (await exchange.open()) {
                exchanges.push(exchange)
            }
        }

        // this.log.info(
        //     JSON.stringify({
        //         event: "GetAllOpenExchanges",
        //         params: {
        //             exchangeAddrs: exchanges.map(exchange => exchange.address),
        //         },
        //     }),
        // )
        return exchanges
    }

    async getExchangeStates(exchangeAddr: string): Promise<ExchangeProps> {
        const exchangeReader = await this.createExchangeReader()
        const props = (await exchangeReader.functions.getExchangeStates(exchangeAddr))[0]
        return {
            priceFeedKey: props.priceFeedKey,
            quoteAssetSymbol: props.quoteAssetSymbol,
            baseAssetSymbol: props.baseAssetSymbol,
            baseAssetReserve: PerpService.fromWei(props.baseAssetReserve),
            quoteAssetReserve: PerpService.fromWei(props.quoteAssetReserve),
        }
    }

    async getPosition(exchangeAddr: string, traderAddr: string): Promise<Position> {
        const sakePerp = await this.createSakePerp()
        const position = (await sakePerp.functions.getPosition(exchangeAddr, traderAddr))[0]
        return {
            size: PerpService.fromWei(position.size.d),
            margin: PerpService.fromWei(position.margin.d),
            openNotional: PerpService.fromWei(position.openNotional.d),
            lastUpdatedCumulativePremiumFraction: PerpService.fromWei(position.lastUpdatedCumulativePremiumFraction.d),
        }
    }

    async getPersonalPositionWithFundingPayment(exchangeAddr: string, traderAddr: string): Promise<Position> {
        const sakePerpViewer = await this.createSakePerpViewer()
        const position = await sakePerpViewer.getPersonalPositionWithFundingPayment(exchangeAddr, traderAddr)
        return {
            size: PerpService.fromWei(position.size.d),
            margin: PerpService.fromWei(position.margin.d),
            openNotional: PerpService.fromWei(position.openNotional.d),
            lastUpdatedCumulativePremiumFraction: PerpService.fromWei(position.lastUpdatedCumulativePremiumFraction.d),
        }
    }

    async getMarginRatio(exchangeAddr: string, traderAddr: string): Promise<Big> {
        const sakePerp = await this.createSakePerp()
        return PerpService.fromWei((await sakePerp.functions.getMarginRatio(exchangeAddr, traderAddr))[0].d)
    }

    async getPositionNotionalAndUnrealizedPnl(
        exchangeAddr: string,
        traderAddr: string,
        pnlCalcOption: PnlCalcOption,
    ): Promise<{
        positionNotional: Big
        unrealizedPnl: Big
    }> {
        const sakePerp = await this.createSakePerp()
        const ret = await sakePerp.getPositionNotionalAndUnrealizedPnl(exchangeAddr, traderAddr, pnlCalcOption)
        return {
            positionNotional: PerpService.fromWei(ret.positionNotional.d),
            unrealizedPnl: PerpService.fromWei(ret.unrealizedPnl.d),
        }
    }

    async openPosition(
        trader: Wallet,
        exchangePair: string,
        exchangeAddr: string,
        side: Side,
        quoteAssetAmount: Big,
        leverage: Big,
        minBaseAssetAmount: Big = Big(0),
        overrides?: Overrides,
    ): Promise<TransactionResponse> {
        const sakePerp = await this.createSakePerp(trader)

        // if the tx gonna fail it will throw here
        // const gasEstimate = await sakePerp.estimateGas.openPosition(
        //     exchangeAddr,
        //     side.valueOf(),
        //     { d: PerpService.toWei(quoteAssetAmount) },
        //     { d: PerpService.toWei(leverage) },
        //     { d: PerpService.toWei(minBaseAssetAmount) },
        // )

        const tx = await sakePerp.functions.openPosition(
            exchangeAddr,
            side.valueOf(),
            { d: PerpService.toWei(quoteAssetAmount) },
            { d: PerpService.toWei(leverage) },
            { d: PerpService.toWei(minBaseAssetAmount) },
            {
                // add a margin for gas limit since its estimation was sometimes too tight
                // gasLimit: BigNumber.from(
                //     Big(gasEstimate.toString())
                //         .mul(Big(1.2))
                //         .toFixed(0),
                // ),
                gasLimit: 2_500_000,
                ...overrides,
            },
        )
        this.log.jinfo({
            event: "OpenPositionTxSent",
            params: {
                exchangePair: exchangePair,
                trader: trader.address,
                amm: exchangeAddr,
                side,
                quoteAssetAmount: +quoteAssetAmount,
                leverage: +leverage,
                minBaseAssetAmount: +minBaseAssetAmount,
                txHash: tx.hash,
                gasPrice: tx.gasPrice.toString(),
                nonce: tx.nonce,
            },
        })

        return tx
    }

    async closePosition(
        trader: Wallet,
        exchangeAddr: string,
        exchangePair: string,
        minBaseAssetAmount: Big = Big(0),
        overrides?: Overrides,
    ): Promise<TransactionResponse> {
        const sakePerp = await this.createSakePerp(trader)
        const tx = await sakePerp.functions.closePosition(
            exchangeAddr,
            { d: PerpService.toWei(minBaseAssetAmount) },
            {
                gasLimit: 2_500_000,
                ...overrides,
            },
        )
        this.log.jinfo({
            event: "ClosePositionTxSent",
            params: {
                trader: trader.address,
                exchangePair: exchangePair,
                txHash: tx.hash,
                gasPrice: tx.gasPrice.toString(),
                nonce: tx.nonce,
            },
        })

        return tx
    }

    async removeMargin(
        trader: Wallet,
        exchangeAddr: string,
        marginToBeRemoved: Big,
        overrides?: Overrides,
    ): Promise<TransactionResponse> {
        const sakePerp = await this.createSakePerp(trader)
        const tx = await sakePerp.functions.removeMargin(
            exchangeAddr,
            { d: PerpService.toWei(marginToBeRemoved) },
            {
                gasLimit: 1_500_000,
                ...overrides,
            },
        )
        this.log.jinfo({
            event: "RemoveMarginTxSent",
            params: {
                trader: trader.address,
                amm: exchangeAddr,
                marginToBeRemoved: +marginToBeRemoved.toFixed(),
                txHash: tx.hash,
                gasPrice: tx.gasPrice.toString(),
                nonce: tx.nonce,
            },
        })
        return tx
    }

    async addMargin(
        trader: Wallet,
        exchangeAddr: string,
        marginToBeAdded: Big,
        overrides?: Overrides,
    ): Promise<TransactionResponse> {
        const sakePerp = await this.createSakePerp(trader)
        const tx = await sakePerp.functions.addMargin(
            exchangeAddr,
            { d: PerpService.toWei(marginToBeAdded) },
            {
                gasLimit: 1_500_000,
                ...overrides,
            },
        )
        this.log.jinfo({
            event: "AddMarginTxSent",
            params: {
                trader: trader.address,
                amm: exchangeAddr,
                marginToBeRemoved: +marginToBeAdded.toFixed(),
                txHash: tx.hash,
                gasPrice: tx.gasPrice.toString(),
                nonce: tx.nonce,
            },
        })
        return tx
    }

    async getUnrealizedPnl(exchangeAddr: string, traderAddr: string, pnlCalOption: PnlCalcOption): Promise<Big> {
        const sakePerpViewer = await this.createSakePerpViewer()
        const unrealizedPnl = (await sakePerpViewer.functions.getUnrealizedPnl(exchangeAddr, traderAddr, BigNumber.from(pnlCalOption)))[0]
        return Big(PerpService.fromWei(unrealizedPnl.d))
    }

    // noinspection JSMethodCanBeStatic
    static fromWei(wei: BigNumber): Big {
        return Big(formatEther(wei))
    }

    // noinspection JSMethodCanBeStatic
    static toWei(val: Big): BigNumber {
        return parseEther(val.toFixed(18))
    }
}
