import "./init"
import { Exchange } from "../types/ethers/Exchange"
import { ERC20Service } from "./ERC20Service"
import { EthMetadata, SystemMetadataFactory } from "./SystemMetadataFactory"
import { EthService } from "./EthService"
import { FtxService } from "./FtxService"
import { Log } from "./Log"
import { MaxUint256 } from "@ethersproject/constants"
import { Mutex } from "async-mutex"
import { PerpService, Side, Position, PnlCalcOption, ExchangeProps } from "./PerpService"
import { ExchangeConfig, PreflightCheck, ConfigHelper } from "./config"
import { ServerProfile } from "./ServerProfile"
import { Service } from "typedi"
import { Wallet } from "ethers"
import Big from "big.js"
import CEXRest from "ftx-api-rest"
import { BinanceService } from "./BinanceService"
import { OkexService } from "./OkexService"
import { HuobiService } from "./HuobiService"
import { CexService, mitigatePositionSizeDiff } from "./CexService"
import { upperCase } from "lodash"
import { PlaceOrderPayload } from "./Types"


@Service()
export class Arbitrageur {
    private readonly log = Log.getLogger(Arbitrageur.name)
    private readonly nonceMutex = new Mutex()
    private readonly sakeperpFee = Big(0.001) // default 0.1%
    private readonly arbitrageur: Wallet
    private readonly cexClient: any
    private readonly cexService: CexService
    private preflightCheck: PreflightCheck
    private exchangeConfigMap: Record<string, ExchangeConfig>

    private nextNonce!: number
    private sakeperpBalance = Big(0)
    private cexAccountValue = Big(0)

    constructor(
        readonly perpService: PerpService,
        readonly erc20Service: ERC20Service,
        readonly ethService: EthService,
        readonly serverProfile: ServerProfile,
        readonly systemMetadataFactory: SystemMetadataFactory,
    ) {
        this.arbitrageur = ethService.privateKeyToWallet(serverProfile.arbitrageurPK)
        const configHelper = new ConfigHelper()
        const[preflightCheck, exchangeConfigMap]= configHelper.parseConfigFile()

        this.preflightCheck = preflightCheck
        this.exchangeConfigMap = exchangeConfigMap

        if (this.serverProfile.cexPlatform === "ftx") {
            this.cexService = new FtxService()
            this.cexClient = new CEXRest({
                key: this.serverProfile.cexApiKey,
                secret: this.serverProfile.cexApiSecret,
                subaccount: this.serverProfile.cexSubaccount,
            })
        } else if (this.serverProfile.cexPlatform === "binance") {
            this.cexService = new BinanceService(this.serverProfile.cexApiKey, this.serverProfile.cexApiSecret)
        } else if (this.serverProfile.cexPlatform === "okex") {
            this.cexService = new OkexService(this.serverProfile.cexApiKey, this.serverProfile.cexApiSecret, this.serverProfile.cexApiPassword)
        } else if (this.serverProfile.cexPlatform === "huobi") {
            this.cexService = new HuobiService(this.serverProfile.cexApiKey, this.serverProfile.cexApiSecret)
        } else {
            this.log.jerror({
                event: "PlatformError",
                params: this.serverProfile.cexPlatform
            })
            process.exit()
        }

    }

    async start(): Promise<void> {
        this.log.jinfo({
            event: "Start",
            params: {
                arbitrageur: this.arbitrageur.address,
            },
        })

        await this.arbitrage()
    }

    async startInterval(): Promise<void> {
        this.log.jinfo({
            event: "StartInterval",
            params: {
                arbitrageur: this.arbitrageur.address,
            },
        })
        await this.arbitrage()
        setInterval(async () => await this.arbitrage(), 1000 * 60 * 1) // default 1 minute
    }

    async checkBlockFreshness(): Promise<void> {
        const latestBlockNumber = await this.ethService.provider.getBlockNumber()
        const latestBlock = await this.ethService.getBlock(latestBlockNumber)
        const diffNowSeconds = Math.floor(Date.now() / 1000) - latestBlock.timestamp
        this.log.jinfo({
            event: "LatestBlock",
            params: {
                latestBlockNumber, diffNowSeconds,
            }
        })
        if (diffNowSeconds > this.preflightCheck.BLOCK_TIMESTAMP_FRESHNESS_THRESHOLD) {
            throw new Error("Get stale block")
        }
    }

    async arbitrage(): Promise<void> {
        this.nextNonce = await this.arbitrageur.getTransactionCount()
        this.log.jinfo({
            event: "NextNonce",
            params: {
                nextNonce: this.nextNonce,
            },
        })

        await this.checkBlockFreshness()

        // Check gas balance - needed for gas payments
        const gasBalance = await this.ethService.getBalance(this.arbitrageur.address)
        this.log.jinfo({
            event: "GasBalance",
            params: { balance: gasBalance.toFixed() },
        })
        if (gasBalance.lt(this.preflightCheck.GAS_BALANCE_THRESHOLD)) {
            this.log.jwarn({
                event: "gasNotEnough",
                params: { balance: gasBalance.toFixed() },
            })
            return
        }

        // Fetch CEX account info
        const cexAccountInfo = await this.cexService.getAccountInfo(this.cexClient)

        // Check CEX balance (USD)
        const cexBalance = cexAccountInfo.freeCollateral
        this.log.jinfo({
            event: "CexUsdBalance",
            params: { balance: cexBalance.toFixed() },
        })
        if (cexBalance.lt(this.preflightCheck.CEX_USD_BALANCE_THRESHOLD)) {
            this.log.jerror({
                event: "CexUsdNotEnough",
                params: { balance: cexBalance.toFixed() },
            })
            return
        }

        // Check CEX margin ratio
        const cexMarginRatio = cexAccountInfo.marginFraction
        this.log.jinfo({
            event: "CexMarginRatio",
            params: { cexMarginRatio: cexMarginRatio.toFixed() },
        })
        if (!cexMarginRatio.eq(0) && cexMarginRatio.lt(this.preflightCheck.CEX_MARGIN_RATIO_THRESHOLD)) {
            this.log.jerror({
                event: "CexMarginRatioTooLow",
                params: { balance: cexMarginRatio.toFixed() },
            })
            return
        }

        this.cexAccountValue = cexAccountInfo.totalAccountValue

        const cexTotalPnlMaps = await this.cexService.getTotalPnLs(this.cexClient)
        for (const marketKey in cexTotalPnlMaps) {
            this.log.jinfo({
                event: "CexPnL",
                params: {
                    marketKey,
                    pnl: cexTotalPnlMaps[marketKey],
                },
            })
        }

        // Check all Perpetual Protocol Exchanges
        const systemMetadata = await this.systemMetadataFactory.fetch()
        const exchanges = await this.perpService.getAllOpenExchanges()

        await Promise.all(
            exchanges.map(async exchange => {
                try {
                    return await this.arbitrageExchange(exchange, systemMetadata)
                } catch (e) {
                    this.log.jerror({
                        event: "ArbitrageExchangeFailed",
                        params: {
                            reason: e.toString(),
                            stackTrace: e.stack,
                        },
                    })
                    return
                }
            }),
        )

        await this.calculateTotalValue(exchanges)
    }

    async arbitrageExchange(exchange: Exchange, systemMetadata: EthMetadata): Promise<void> {
        const exchangeState = await this.perpService.getExchangeStates(exchange.address)
        const exchangePair = this.getExchangePair(exchangeState)
        const exchangeConfig = this.exchangeConfigMap[exchangePair]

        if (!exchangeConfig) {
            this.log.jinfo({
                event: "ExchangeConfigMissing",
                params: {
                    exchange: exchange.address,
                    exchangePair,
                },
            })
            return
        }

        if (!exchangeConfig.ENABLED) {
            return
        }

        this.log.jinfo({
            event: "ArbitrageExchange",
            params: {
                exchange: exchange.address,
                exchangeConfig,
                exchangePair,
            },
        })

        const arbitrageurAddr = this.arbitrageur.address
        const sakePerpAddr = systemMetadata.sakePerpAddr
        const quoteAssetAddr = await exchange.quoteAsset()

        // Check Perpetual Protocol balance - quote asset is USDC
        const quoteBalance = await this.erc20Service.balanceOf(quoteAssetAddr, arbitrageurAddr)
        if (quoteBalance.lt(this.preflightCheck.USD_BALANCE_THRESHOLD)) {
            this.log.jwarn({
                event: "QuoteAssetNotEnough",
                params: { balance: quoteBalance.toFixed() },
            })
            // NOTE we don't abort prematurely here because we don't know yet which direction
            // the arbitrageur will go. If it's the opposite then it doesn't need more quote asset to execute
        }

        this.sakeperpBalance = quoteBalance

        // Make sure the quote asset are approved
        const allowance = await this.erc20Service.allowance(quoteAssetAddr, arbitrageurAddr, sakePerpAddr)
        const infiniteAllowance = await this.erc20Service.fromScaled(quoteAssetAddr, MaxUint256)
        const allowanceThreshold = infiniteAllowance.div(2)
        if (allowance.lt(allowanceThreshold)) {
            await this.erc20Service.approve(quoteAssetAddr, sakePerpAddr, infiniteAllowance, this.arbitrageur, {
                gasPrice: await this.ethService.getSafeGasPrice(),
            })
            this.log.jinfo({
                event: "SetMaxAllowance",
                params: {
                    quoteAssetAddr: quoteAssetAddr,
                    owner: this.arbitrageur.address,
                    agent: sakePerpAddr,
                },
            })
        }

        // List Perpetual Protocol positions
        const [position, unrealizedPnl] = await Promise.all([
            this.perpService.getPersonalPositionWithFundingPayment(exchange.address, this.arbitrageur.address),
            this.perpService.getUnrealizedPnl(exchange.address, this.arbitrageur.address, PnlCalcOption.SPOT_PRICE),
        ])

        this.log.jinfo({
            event: "SakePerpPosition",
            params: {
                exchangePair,
                size: +position.size,
                margin: +position.margin,
                openNotional: +position.openNotional,
            },
        })

        this.log.jinfo({
            event: "SakePerpPnL",
            params: {
                exchangePair,
                margin: +position.margin,
                unrealizedPnl: +unrealizedPnl,
                quoteBalance: +quoteBalance,
                accountValue: +position.margin.add(unrealizedPnl).add(quoteBalance),
            },
        })

        // List CEX positions
        const cexPosition = await this.cexService.getPosition(this.cexClient, exchangeConfig.CEX_MARKET_ID)
        if (cexPosition) {
            const cexSizeDiff = cexPosition.netSize.abs().sub(position.size.abs())
            this.log.jinfo({
                event: "CexPosition",
                params: {
                    marketId: cexPosition.future,
                    size: +cexPosition.netSize,
                    diff: +cexSizeDiff,
                },
            })

            if (cexSizeDiff.abs().gte(exchangeConfig.CEX_MIN_TRADE_SIZE)) {
                const mitigation = mitigatePositionSizeDiff(position.size, cexPosition.netSize)
                this.log.jinfo({
                    event: "MitigateCEXPositionSizeDiff",
                    params: {
                        sakeperpPositionSize: position.size,
                        cexPositionSize: cexPosition.netSize,
                        size: mitigation.sizeAbs,
                        side: mitigation.side,
                    },
                })
                await this.openCEXPosition(exchangeConfig.CEX_MARKET_ID, exchangeConfig.SAKEPERP_LEVERAGE, mitigation.sizeAbs, mitigation.side)
            }
        }

        // Adjust Perpetual Protocol margin
        if (!position.size.eq(0)) {
            const marginRatio = await this.perpService.getMarginRatio(exchange.address, arbitrageurAddr)
            // note positionNotional is an estimation because the real margin ratio is calculated based on two mark price candidates: SPOT & TWAP.
            // we pick the more "conservative" one (SPOT) here so the margin required tends to fall on the safer side
            const {
                positionNotional: spotPositionNotional,
            } = await this.perpService.getPositionNotionalAndUnrealizedPnl(
                exchange.address,
                this.arbitrageur.address,
                PnlCalcOption.SPOT_PRICE,
            )
            this.log.jinfo({
                event: "MarginRatioBefore",
                params: {
                    marginRatio: +marginRatio,
                    spotPositionNotional: +spotPositionNotional,
                    exchangePair,
                },
            })
            const expectedMarginRatio = new Big(1).div(exchangeConfig.SAKEPERP_LEVERAGE)
            if (marginRatio.gt(expectedMarginRatio.mul(new Big(1).add(exchangeConfig.ADJUST_MARGIN_RATIO_THRESHOLD)))) {
                // marginToBeRemoved = -marginToChange
                //                   = (marginRatio - expectedMarginRatio) * positionNotional
                let marginToBeRemoved = marginRatio.sub(expectedMarginRatio).mul(spotPositionNotional)

                // cap the reduction by the current (funding payment realized) margin
                if (marginToBeRemoved.gt(position.margin)) {
                    marginToBeRemoved = position.margin
                }
                if (marginToBeRemoved.gt(Big(0))) {
                    this.log.jinfo({
                        event: "RemoveMargin",
                        params: {
                            exchangePair,
                            marginToBeRemoved: +marginToBeRemoved,
                        },
                    })

                    const release = await this.nonceMutex.acquire()
                    let tx
                    try {
                        tx = await this.perpService.removeMargin(this.arbitrageur, exchange.address, marginToBeRemoved, {
                            nonce: this.nextNonce,
                            gasPrice: await this.ethService.getSafeGasPrice(),
                        })
                        this.nextNonce++
                    } finally {
                        release()
                    }
                    await tx.wait()
                    this.log.jinfo({
                        event: "MarginRatioAfter",
                        params: {
                            exchangePair,
                            marginRatio: (
                                await this.perpService.getMarginRatio(exchange.address, arbitrageurAddr)
                            ).toFixed(),
                        },
                    })
                }
            } else if (
                marginRatio.lt(expectedMarginRatio.mul(new Big(1).sub(exchangeConfig.ADJUST_MARGIN_RATIO_THRESHOLD)))
            ) {
                // marginToBeAdded = marginToChange
                //                 = (expectedMarginRatio - marginRatio) * positionNotional
                let marginToBeAdded = expectedMarginRatio.sub(marginRatio).mul(spotPositionNotional)
                marginToBeAdded = marginToBeAdded.gt(quoteBalance) ? quoteBalance : marginToBeAdded
                this.log.jinfo({
                    event: "AddMargin",
                    params: {
                        exchangePair,
                        marginToBeAdded: marginToBeAdded.toFixed(),
                    },
                })

                const release = await this.nonceMutex.acquire()
                let tx
                try {
                    tx = await this.perpService.addMargin(this.arbitrageur, exchange.address, marginToBeAdded, {
                        nonce: this.nextNonce,
                        gasPrice: await this.ethService.getSafeGasPrice(),
                    })
                    this.nextNonce++
                } finally {
                    release()
                }
                await tx.wait()
                this.log.jinfo({
                    event: "MarginRatioAfter",
                    params: {
                        exchangePair,
                        marginRatio: (await this.perpService.getMarginRatio(exchange.address, arbitrageurAddr)).toFixed(),
                    },
                })
            }
        }

        // NOTE If the arbitrageur is already out of balance,
        // we will leave it as is and not do any rebalance work

        // Fetch prices
        const [exchangePrice, cexPrice, oraclePrice] = await Promise.all([
            this.fetchExchangePrice(exchange),
            this.fetchCexPrice(exchangeConfig),
            this.fetchOraclePrice(exchange),
        ])

        // Calculate spread
        // NOTE We assume CEX liquidity is always larger than Perpetual Protocol,
        // so we use Perpetual Protocol to calculate the max slippage
        const spread = exchangePrice.sub(cexPrice).div(cexPrice)
        const amount = Arbitrageur.calcMaxSlippageAmount(
            exchangePrice,
            exchangeConfig.MAX_SLIPPAGE_RATIO,
            exchangeState.baseAssetReserve,
            exchangeState.quoteAssetReserve,
        )

        this.log.jinfo({
            event: "CalculatedPrice",
            params: {
                exchangePair,
                ammPrice: exchangePrice.toFixed(4),
                oraclePrice: oraclePrice.toFixed(4),
                cexPrice: cexPrice.toFixed(4),
                amm_oracle: exchangePrice.sub(oraclePrice).div(oraclePrice).toFixed(4), 
                amm_cex: spread.toFixed(4),
                oracle_cex: oraclePrice.sub(cexPrice).div(cexPrice).toFixed(4),
            },
        })

        // Open positions if needed
        if (spread.lt(exchangeConfig.SAKEPERP_LONG_ENTRY_TRIGGER)) {
            const result = await this.perpService.checkWaitingPeriod(this.arbitrageur, exchange.address, this.arbitrageur.address, Side.BUY)
            if (!result){
                return
            }

            const regAmount = this.calculateRegulatedPositionNotional(exchangeConfig, quoteBalance, amount, position, Side.BUY)
            const cexPositionSizeAbs = this.calculateCEXPositionSize(exchangeConfig, regAmount, cexPrice)
            if (cexPositionSizeAbs.eq(Big(0))) {
                return
            }

            await Promise.all([
                this.openCEXPosition(exchangeConfig.CEX_MARKET_ID, exchangeConfig.SAKEPERP_LEVERAGE, cexPositionSizeAbs, Side.SELL),
                this.openSakePerpPosition(exchange, exchangePair, regAmount, exchangeConfig.SAKEPERP_LEVERAGE, Side.BUY),
            ])
        } else if (spread.gt(exchangeConfig.SAKEPERP_SHORT_ENTRY_TRIGGER)) {
            const result = await this.perpService.checkWaitingPeriod(this.arbitrageur, exchange.address, this.arbitrageur.address, Side.SELL)
            if (!result){
                return
            }

            const regAmount = this.calculateRegulatedPositionNotional(exchangeConfig, quoteBalance, amount, position, Side.SELL)
            const cexPositionSizeAbs = this.calculateCEXPositionSize(exchangeConfig, regAmount, cexPrice)
            if (cexPositionSizeAbs.eq(Big(0))) {
                return
            }

            await Promise.all([
                this.openCEXPosition(exchangeConfig.CEX_MARKET_ID, exchangeConfig.SAKEPERP_LEVERAGE, cexPositionSizeAbs, Side.BUY),
                this.openSakePerpPosition(exchange, exchangePair, regAmount, exchangeConfig.SAKEPERP_LEVERAGE, Side.SELL),
            ])
        } else {
            this.log.jinfo({
                event: "NotTriggered",
                params: {
                    spread,
                    exchangeConfig
                },
            })
        }
    }

    getExchangePair(exchangeState: ExchangeProps): string {
        return `${exchangeState.baseAssetSymbol}-${exchangeState.quoteAssetSymbol}`
    }

    async fetchExchangePrice(exchange: Exchange): Promise<Big> {
        const exchangeState = await this.perpService.getExchangeStates(exchange.address)
        const exchangePrice = exchangeState.quoteAssetReserve.div(exchangeState.baseAssetReserve)
        const exchangePair = this.getExchangePair(exchangeState)
        this.log.jinfo({
            event: "SakePerpPrice",
            params: {
                exchangePair: exchangePair,
                price: exchangePrice.toFixed(),
            },
        })
        return exchangePrice
    }

    async fetchCexPrice(exchangeConfig: ExchangeConfig): Promise<Big> {
        const cexMarket = await this.cexService.getMarket(exchangeConfig.CEX_MARKET_ID)
        const cexPrice = cexMarket.last!
        this.log.jinfo({
            event: "CexPrice",
            params: {
                tokenPair: exchangeConfig.CEX_MARKET_ID,
                price: cexPrice.toFixed(),
            },
        })
        return cexPrice
    }

    async fetchOraclePrice(exchange: Exchange): Promise<Big> {
        const oraclePrice = await exchange.functions.getUnderlyingPrice()
        return PerpService.fromWei(oraclePrice[0].d)
    }

    calculateRegulatedPositionNotional(exchangeConfig: ExchangeConfig, quoteBalance: Big, maxSlippageAmount: Big, position: Position, side: Side): Big {
        let maxOpenNotional = Big(0)

        // Example
        // asset cap >> 1000
        // you have long position notional >> 900
        // you can short >> 1900 maximum
        if (position.size.gte(0) && side == Side.SELL) {
            maxOpenNotional = exchangeConfig.ASSET_CAP.add(position.openNotional)
        }

        // Example
        // asset cap >> 1000
        // you have short position notional >> 900
        // you can long >> 1900 maximum
        else if (position.size.lte(0) && side == Side.BUY) {
            maxOpenNotional = exchangeConfig.ASSET_CAP.add(position.openNotional)
        }

        // Example
        // asset cap >> 1000
        // you have long position notional >> 900
        // you can long >> 100 maximum
        else if (position.size.gte(0) && side == Side.BUY) {
            maxOpenNotional = exchangeConfig.ASSET_CAP.sub(position.openNotional)
            if (maxOpenNotional.lt(0)) {
                maxOpenNotional = Big(0)
            }
        }

        // Example
        // asset cap >> 1000
        // you have short position notional >> 900
        // you can short >> 100 maximum
        else if (position.size.lte(0) && side == Side.SELL) {
            maxOpenNotional = exchangeConfig.ASSET_CAP.sub(position.openNotional)
            if (maxOpenNotional.lt(0)) {
                maxOpenNotional = Big(0)
            }
        }

        let amount = maxSlippageAmount
        if (amount.gt(maxOpenNotional)) {
            amount = maxOpenNotional
            this.log.jinfo({
                event: "AmountSakePerpExceedCap",
                params: {
                    exchangeConfig,
                    side,
                    size: +position.size,
                    openNotional: +position.openNotional,
                    maxSlippageAmount: +maxSlippageAmount,
                    maxOpenNotional: +maxOpenNotional,
                    amount: +amount,
                },
            })
        }

        const feeSafetyMargin = exchangeConfig.ASSET_CAP.mul(this.sakeperpFee).mul(3)
        if (amount.gt(quoteBalance.sub(feeSafetyMargin).mul(exchangeConfig.SAKEPERP_LEVERAGE))) {
            amount = quoteBalance.sub(feeSafetyMargin).mul(exchangeConfig.SAKEPERP_LEVERAGE)
        }

        if (amount.lt(exchangeConfig.SAKEPERP_MIN_TRADE_NOTIONAL)) {
            amount = Big(0)
            this.log.jinfo({
                event: "AmountNotReachSakePerpMinTradeNotional",
                params: {
                    exchangeConfig,
                    side,
                    size: +position.size,
                    openNotional: +position.openNotional,
                    maxSlippageAmount: +maxSlippageAmount,
                    maxOpenNotional: +maxOpenNotional,
                    feeSafetyMargin: +feeSafetyMargin,
                    amount: +amount,
                },
            })
        } else if (amount.eq(Big(0))) {
            this.log.jinfo({
                event: "AmountZero",
                params: {
                    exchangeConfig,
                    side,
                    size: +position.size,
                    openNotional: +position.openNotional,
                    maxSlippageAmount: +maxSlippageAmount,
                    maxOpenNotional: +maxOpenNotional,
                    feeSafetyMargin: +feeSafetyMargin,
                    amount: +amount,
                },
            })
        } else {
            this.log.jinfo({
                event: "AmountCalculated",
                params: {
                    exchangeConfig,
                    side,
                    size: +position.size,
                    openNotional: +position.openNotional,
                    maxSlippageAmount: +maxSlippageAmount,
                    maxOpenNotional: +maxOpenNotional,
                    feeSafetyMargin: +feeSafetyMargin,
                    amount: +amount,
                },
            })
        }
        return amount
    }

    calculateCEXPositionSize(exchangeConfig: ExchangeConfig, sakeperpRegulatedPositionNotional: Big, cexPrice: Big): Big {
        let cexPositionSizeAbs = sakeperpRegulatedPositionNotional
            .div(cexPrice)
            .abs()
            .round(3) // round to CEX decimals
        if (cexPositionSizeAbs.lt(exchangeConfig.CEX_MIN_TRADE_SIZE)) {
            cexPositionSizeAbs = Big(0)
            this.log.jinfo({
                event: "PositionSizeNotReachCEXMinTradeSize",
                params: {
                    exchangeConfig,
                    cexPositionSizeAbs: +cexPositionSizeAbs,
                },
            })
        }
        return cexPositionSizeAbs
    }

    static calcQuoteAssetNeeded(baseAssetReserve: Big, quoteAssetReserve: Big, price: Big): Big {
        // quoteAssetNeeded = sqrt(quoteAssetReserve * baseAssetReserve * price) - quoteAssetReserve
        const exchangePrice = quoteAssetReserve.div(baseAssetReserve)
        if (exchangePrice.eq(price)) return Big(0)
        return quoteAssetReserve
            .mul(baseAssetReserve)
            .mul(price)
            .sqrt()
            .minus(quoteAssetReserve)
    }

    static calcMaxSlippageAmount(exchangePrice: Big, maxSlippage: Big, baseAssetReserve: Big, quoteAssetReserve: Big): Big {
        const targetAmountSq = exchangePrice
            .mul(new Big(1).add(maxSlippage))
            .mul(baseAssetReserve)
            .mul(quoteAssetReserve)
        return targetAmountSq.sqrt().sub(quoteAssetReserve)
    }

    private async openSakePerpPosition(exchange: Exchange, exchangePair: string, quoteAssetAmount: Big, leverage: Big, side: Side): Promise<void> {
        const amount = quoteAssetAmount.div(leverage)
        const gasPrice = await this.ethService.getSafeGasPrice()

        const release = await this.nonceMutex.acquire()
        let tx
        try {
            tx = await this.perpService.openPosition(
                this.arbitrageur,
                exchange.address,
                side,
                amount,
                leverage,
                Big(0),
                {
                    nonce: this.nextNonce,
                    gasPrice,
                },
            )
            this.nextNonce++
        } finally {
            release()
        }

        this.log.jinfo({
            event: "OpenSakePerpPosition",
            params: {
                exchange: exchange.address,
                exchangePair,
                side,
                quoteAssetAmount: +quoteAssetAmount,
                leverage: leverage.toFixed(),
                txHash: tx.hash,
                gasPrice: tx.gasPrice.toString(),
                nonce: tx.nonce,
            },
        })
        await tx.wait()
    }

    private async openCEXPosition(marketId: string, leverage: Big, positionSizeAbs: Big, side: Side): Promise<void> {
        let _type = "market"
        let _side = side === Side.BUY ? "buy" : "sell"
        
        if (this.serverProfile.cexPlatform === "binance") {
            _type = upperCase(_type)
            _side = upperCase(_side)
        }

        const payload: PlaceOrderPayload = {
            market: marketId,
            side: _side,
            price: null,
            size: parseFloat(positionSizeAbs.toFixed(3)), // rounding to CEX contract decimals
            type: _type,
            leverage: leverage,
        }

        this.log.jinfo({
            event: "OpenCEXPosition",
            params: payload,
        })
        await this.cexService.placeOrder(this.cexClient, payload)
    }

    async calculateTotalValue(exchanges: Exchange[]): Promise<void> {
        let totalPositionValue = Big(0)
        for (let exchange of exchanges) {
            const [position, unrealizedPnl] = await Promise.all([
                this.perpService.getPersonalPositionWithFundingPayment(exchange.address, this.arbitrageur.address),
                this.perpService.getUnrealizedPnl(exchange.address, this.arbitrageur.address, PnlCalcOption.SPOT_PRICE),
            ])
            totalPositionValue = totalPositionValue.add(position.margin).add(unrealizedPnl)
        }
        this.log.jinfo({
            event: "TotalAccountValue",
            params: {
                totalValue: +this.sakeperpBalance.add(this.cexAccountValue).add(totalPositionValue),
                sakeperpBalance: +this.sakeperpBalance,
                cexAccountValue: +this.cexAccountValue,
                totalPositionValue: +totalPositionValue,
            },
        })
    }
}
