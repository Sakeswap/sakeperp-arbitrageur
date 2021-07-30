import { BigNumber } from "@ethersproject/bignumber"
import { Block, WebSocketProvider } from "@ethersproject/providers"
import { ethers, Wallet } from "ethers"
import { Log } from "./Log"
import { parseUnits } from "@ethersproject/units"
import { ServerProfile } from "./ServerProfile"
import { Service } from "typedi"
import { sleep } from "./util"
import { TransactionReceipt, TransactionResponse } from "@ethersproject/abstract-provider"
import Big from "big.js"

@Service()
export class EthService {
    provider!: WebSocketProvider
    static readonly log = Log.getLogger(EthService.name)

    constructor(readonly serverProfile: ServerProfile) {
        this.provider = this.initProvider()
    }

    initProvider(): WebSocketProvider {
        const provider = new WebSocketProvider(this.serverProfile.web3Endpoint)
        provider._websocket.on("close", async (code: any) => {
            await EthService.log.warn(
                JSON.stringify({
                    event: "ReconnectWebSocket",
                    params: { code },
                }),
            )
            provider._websocket.terminate()
            await sleep(3000) // wait before reconnect
            this.provider = this.initProvider() // reconnect and replace the original provider
        })
        return provider
    }

    privateKeyToWallet(privateKey: string): Wallet {
        return new ethers.Wallet(privateKey, this.provider)
    }

    createContract<T>(address: string, abi: ethers.ContractInterface, signer?: ethers.Signer): T {
        return (new ethers.Contract(address, abi, signer ? signer : this.provider) as unknown) as T
    }

    async getBlock(blockNumber: number): Promise<Block> {
        return await this.provider.getBlock(blockNumber)
    }

    async getSafeGasPrice(): Promise<BigNumber> {
        for (let i = 0; i < 3; i++) {
            const gasPrice = Big((await this.provider.getGasPrice()).toString())
            if (gasPrice.gt(Big(0))) {
                return parseUnits(
                    gasPrice
                        .mul(1.0001) // add 20% markup so the tx is more likely to pass
                        .toFixed(0),
                    0,
                )
            }
        }
        throw new Error("GasPrice is 0")
    }

    async getBalance(addr: string): Promise<Big> {
        const balance = await this.provider.getBalance(addr)
        return new Big(ethers.utils.formatEther(balance))
    }

    static async supervise(
        signer: Wallet,
        tx: TransactionResponse,
        timeout: number,
        retry = 3,
    ): Promise<TransactionReceipt> {
        return new Promise((resolve, reject) => {
            // Set timeout for sending cancellation tx at double the gas price
            const timeoutId = setTimeout(async () => {
                const cancelTx = await signer.sendTransaction({
                    to: signer.address,
                    value: 0,
                    gasPrice: tx.gasPrice?.mul(2), // TODO Make configurable?
                    nonce: tx.nonce,
                })

                await EthService.log.warn(
                    JSON.stringify({
                        event: "txCancelling",
                        params: {
                            tx: tx.hash,
                            txGasPrice: tx.gasPrice?.toString(),
                            cancelTx: cancelTx.hash,
                            cancelTxGasPrice: cancelTx.gasPrice?.toString(),
                            nonce: cancelTx.nonce,
                        },
                    }),
                )

                // Yo dawg I heard you like cancelling tx so
                // we put a cancel in your cancel tx so you can supervise while you supervise
                if (retry > 0) {
                    await EthService.supervise(signer, cancelTx, timeout, retry - 1)
                } else {
                    await cancelTx.wait()
                }
                reject({
                    reason: "timeout",
                    tx: tx.hash,
                    cancelTx: cancelTx.hash,
                })
            }, timeout)

            // Otherwise, resolve normally if the original tx is confirmed
            tx.wait().then(result => {
                clearTimeout(timeoutId)
                resolve(result)
            })
        })
    }
}
