import { BigNumber } from "@ethersproject/bignumber"
import { Overrides } from "@ethersproject/contracts"
import ERC20TokenArtifact from "@sakeperp/artifact/src/ERC20Token.json"
import Big from "big.js"
import { ethers, Wallet } from "ethers"
import { Service } from "typedi"
import { ERC20Token } from "../types/ethers/ERC20Token"
import { EthService } from "./EthService"
import { Log } from "./Log"
import { SystemMetadataFactory } from "./SystemMetadataFactory"

@Service()
export class ERC20Service {
    private readonly log = Log.getLogger(ERC20Service.name)

    constructor(readonly ethService: EthService, readonly systemMetadataFactory: SystemMetadataFactory) {}

    private createErc20Contract(tokenAddr: string, from?: Wallet): ERC20Token {
        return this.ethService.createContract<ERC20Token>(tokenAddr, ERC20TokenArtifact, from)
    }

    async allowance(tokenAddr: string, ownerAddr: string, spenderAddr: string): Promise<Big> {
        const token = this.createErc20Contract(tokenAddr)
        const scaledAmount = await token.functions.allowance(ownerAddr, spenderAddr)
        return this.fromScaled(tokenAddr, scaledAmount[0])
    }

    async approve(
        tokenAddr: string,
        spenderAddr: string,
        amount: Big,
        from: Wallet,
        overrides?: Overrides,
    ): Promise<void> {
        const token = this.createErc20Contract(tokenAddr, from)
        const scaledAmount = await this.toScaled(tokenAddr, amount)
        const tx = await token.functions.approve(spenderAddr, scaledAmount, {
            ...overrides,
        })
        const receipt = await tx.wait()
        if (receipt.status !== 1) throw new Error(`transferError:${tx.hash}`)
    }

    async balanceOf(tokenAddr: string, accountAddr: string): Promise<Big> {
        const token = this.createErc20Contract(tokenAddr)
        const scaledAmount = await token.functions.balanceOf(accountAddr)
        return this.fromScaled(tokenAddr, scaledAmount[0])
    }

    async transfer(tokenAddr: string, recipientAddr: string, amount: Big, from: Wallet): Promise<void> {
        const token = this.createErc20Contract(tokenAddr, from)
        const scaledAmount = await this.toScaled(tokenAddr, amount)
        const tx = await token.functions.transfer(recipientAddr, scaledAmount)
        const receipt = await tx.wait()
        if (receipt.status !== 1) throw new Error(`transferError:${tx.hash}`)
    }

    // noinspection JSMethodCanBeStatic
    async fromScaled(tokenAddr: string, val: BigNumber): Promise<Big> {
        const token = this.createErc20Contract(tokenAddr)
        const decimals = await token.functions.decimals()
        return new Big(ethers.utils.formatUnits(val, decimals[0]))
    }

    // noinspection JSMethodCanBeStatic
    async toScaled(tokenAddr: string, val: Big): Promise<ethers.BigNumber> {
        const token = this.createErc20Contract(tokenAddr)
        const decimals = await token.functions.decimals()
        return ethers.utils.parseUnits(val.toFixed(decimals[0]), decimals[0])
    }
}
