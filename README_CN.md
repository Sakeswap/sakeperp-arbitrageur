# sakeperp-arbitrageur

**[English](README.md)** **[中文](README_CN.md)**

`sakeperp-arbitrageur`是一个套利机器人，在 [SakePerp.fi](https://sakeperp.fi/) 和中心化交易所之间执行自动交易策略。现支持的中心化交易所为币安、火币、欧易以及FTX。


# 默认套利策略
默认套利策略为 "低买高卖"，在两个不同的交易所之间赚取利润。

该策略背后的逻辑是，在 SakePerp.fi 和CEX有独立的价格发现机制，所以有时可能出现同一交易对的价格差异，但从长期来看，它们趋近一致。


例如，当SakePerp上的ETH-perp是1500，而FTX是1520，我们可以在SakePerp做多ETH-perp，而在FTX做空，期望一段时间后价格会趋于一致。假设SakePerp的价格上升到1550，而FTX的价格上升到1545。机器人将卖出两个交易所的头寸。这个例子中的PnL将是SakePerp+50美元，FTX-25美元，总共+25美元。

更多情况列举如下：

| State   | SakePerp_Price | SakePerp_PNL | FTX_Price | FTX_PNL | Total_PNL |
| ------- | -------------- | ------------ | --------- | ------- | --------- |
| Initial | 1500           | long         | 1520      | short   |           |
| Case1   | 1550           | +50          | 1545      | -25     | +25       |
| Case2   | 1455           | -45          | 1450      | +70     | +25       |
| Initial | 1520           | short        | 1500      | long    |           |
| Case3   | 1545           | -25          | 1550      | +50     | +25       |
| Case4   | 1450           | +70          | 1455      | -45     | +25       |

除了默认策略外，还添加了几个功能：
- 循环开仓模型到开关仓模型.
- 余额监控和邮件通知. 

# 注意

注意此开源套利机器人仅为教育目的。

1. 衍生品交易风险巨大，可能会导致资金损失高达100%。

   请仔细查看代码中每个参数的定义。确保你在交易前充分了解参数，如杠杆率、触发条件、退出条件等。

2. 永续合约交易在你所在的地区可能受到监管。

   请务必在交易前检查当地法律。

   

# 如何运作

## 账户准备

- 存入BUSD以及BNB在BSC钱包账户 [SakePerp Exchange](https://www.binance.com/zh-CN/busd)
- 在中心化交易所账户存入足够资金 (Binance/FTX), 创建并保存账户API。

## 下载

```bash
$ git clone https://github.com/Sakeswap/sakeperp-arbitrageur.git
$ cd sakeperp-arbitrageur
```

## 配置

需要BSC钱包账户的私钥以及中心化交易账户的API `config/.env.production`:

```bash
WEB3_ENDPOINT=wss://bsc-ws-node.nariox.org:443
# The private key must start with "0x" - add it if necessary (e.g. from private key exported from Metamask)
ARBITRAGEUR_PK=YOUR_WALLET_PRIVATE_KEY

# binance/ftx
CEX_PLATFORM=binance

# CEX API keys
CEX_API_KEY=YOUR_CEX_API_KEY
CEX_API_SECRET=YOUR_CEX_API_SECRET
CEX_API_PASSWORD=YOU_API_KEY_PASSWORD
# Only provide this if you're using a subaccount for CEX
# CEX_SUBACCOUNT=YOUR_CEX_SUBACCOUNT_NAME

# set true would persist log to file, if no need, set false
LOG_PERSISTENCE=false
```
**注意**

1. `WEB3_ENDPOINT` `.env.production` 默认设置端点为币安官方端点，但并不稳定。强烈建议建立自己的BSC节点或是购买专业第三方服务。
   1. QuikNode : [https://quiknode.io](https://quiknode.io/)
   2. ANKR: https://app.ankr.com/api
   3. GetBlock.io: https://getblock.io/nodes/bsc

2.  `sakeperp-arbitrageur` 目前支持 [Binance](https://www.binance.com/), [FTX](https://ftx.com/), [Huobi](https://www.huobi.com/) 以及 [OKEx](https://www.okex.com/)很快会支持.


`config/config.json`中配置参数:

```
{
    "PreflightCheck": {
        "BLOCK_TIMESTAMP_FRESHNESS_THRESHOLD": 1800, // default 30 minutes; this is a safety check. Occasionally, BSC's official WebSocket endpoint may return out-dated block data
        "GAS_BALANCE_THRESHOLD": 1,   // minimum BNB available for gas fees;
        "USD_BALANCE_THRESHOLD": 100, // minimum BUSD balance in your wallet
        "CEX_USD_BALANCE_THRESHOLD": 100, // minimum USD balance on CEX
        "CEX_MARGIN_RATIO_THRESHOLD": 0.1 // minimum margin ratio in your CEX margin trading
    },
    "ExchangeConfig": [
        {
            "Pair": "BTC-BUSD",
            "ENABLED": true,   // "true to enable it, "false" to disable it
            "ASSET_CAP": 1000,   // You may adjust it based on your own risk.
            "SAKEPERP_LEVERAGE": 5,    // You may adjust it based on your own risk.
            "SAKEPERP_MIN_TRADE_NOTIONAL": 10,
            "SAKEPERP_LONG_ENTRY_TRIGGER": -0.005, // open the long position at Perp exchange when the spread is =< -0.5%
            "SAKEPERP_LONG_CLOSE_TRIGGER": 0.002,        // close long position when spread is >= 0.2% 
            "SAKEPERP_LONG_OPEN_PRICE_SPREAD": 0.05,     // close long position when amm price and open price spread is > 5%
            "SAKEPERP_LONG_CEX_OPEN_PRICE_SPREAD": 0.02, // close long position if oracle don't move, cex price and open price spread >= 2% 
            "SAKEPERP_SHORT_ENTRY_TRIGGER": 0.005, // open the short position at Perp exchange when the spread is >= 0.5 %    
            "SAKEPERP_SHORT_CLOSE_TRIGGER": -0.002,   // close short position when spread is <= -0.2%  
            "SAKEPERP_SHORT_OPEN_PRICE_SPREAD": -0.05,// close short position when amm price and open price spread is < -5% 
            "SAKEPERP_SHORT_CEX_OPEN_PRICE_SPREAD": -0.02, // close short position if oracle don't move, cex price and open price spread <= -2%  
            "ADJUST_MARGIN_RATIO_THRESHOLD": 0.1,
            "MAX_SLIPPAGE_RATIO": 0.001,  // set the max slippage ratio limit to avoid large slippage 
            "CEX_MARKET_ID": "BTC-USDT",  // perpetual pair name in Binance/FTX
            "CEX_MIN_TRADE_SIZE": 0.001   
        },
        .....
     ]
}
```

**注意:**

1. `CEX_MARKET_ID` 在每个中心化交易所中并不相同，确保使用了相对应的ID。
2. [config/config.json](https://github.com/Sakeswap/sakeperp-arbitrageur/blob/main/config/config.json) 以及 [src/Arbitrageur.ts](https://github.com/Sakeswap/sakeperp-arbitrageur/blob/main/src/Arbitrageur.ts)可了解更多详情。

## 运行

通过两种方法可以运行 `sakeperp-arbitrageur`:

### 1.npm

```bash
$ npm install
$ npm run build
$ npm run arbitrage
```

### 2.Docker

创建一个Docker镜像:
```
docker build -t  sakeperp/arbitrageur  .
```

新建folder
```
mkdir sakeperp-arbitrageur
cd  sakeperp-arbitrageur
```

复制 `.env.production` , `config.json` 以及`tradingdata.json`从 /config folder 到一个新的文件夹，并创建一个新的docker-compose.yml file ：
```yml
version: "3.5"

services:
  sakeperp-arbitrageur:
    image: sakeperp/arbitrageur:latest
    container_name: sakeperp-arbitrageur
    volumes:
      - type: bind
        source: .
        target: /usr/src/app/config/
    restart: unless-stopped
    command: npm run arbitrage

```

开始 docker container：
```
docker-compose up -d
```
如果改变 `config.json`, 请重启 docker container

## 反馈

如果发现任何问题，请提交Issue 或者 PR, 谢谢。