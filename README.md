# sakeperp-arbitrageur
The `sakeperp-arbitrageur` is an arbitrage bot that  execute automated trading strategies between SakePerp ([site](https://sakeperp.fi/)) and centralized perpetual exchange like Binance/FTX/Huobi/OKex.



# Default Strategy
The default strategy is to "buy low, sell high" to make profit between two different exchanges. 

The logic behind the the strategy is that the independent price discovery during SakePerp and CEX may lead to price difference for the same trading pair sometimes, but they are tend to be consistent in the long term.

For example, when the ETH-perp on SakePerp is 1500, and 1520 at FTX, we could long ETH-perp at Perp exchange, and short at FTX in the expectation that some time later the prices will converge. Let's say the price at SakePerp increases to 1550, and the price at FTX increases to 1545. The bot will sell the positions at both exchanges. The PnL in this example will be +50 USD on SakePerp, and -25 USD at FTX, for a total of +25 USD. 

See the following table for multiple cases.

| State   | SakePerp_Price | SakePerp_PNL | FTX_Price | FTX_PNL | Total_PNL |
| ------- | -------------- | ------------ | --------- | ------- | --------- |
| Initial | 1500           | long         | 1520      | short   |           |
| Case1   | 1550           | +50          | 1545      | -25     | +25       |
| Case2   | 1455           | -45          | 1450      | +70     | +25       |
| Initial | 1520           | short        | 1500      | long    |           |
| Case3   | 1545           | -25          | 1550      | +50     | +25       |
| Case4   | 1450           | +70          | 1455      | -45     | +25       |



# Attentions

Pay attention that this code is provided for educational purposes only.

1. Derivatives trading carries substantial risks and possible loss of up to 100% of your funds. 

   Please review the definitions of each parameter in the code carefully. Make sure you fully understand the parameters like leverage, trigger conditions, exit conditions and etc before trading.

2. Perpetual contract trading may be regulated in your jurisdiction. 

   Be sure to check local laws before trading and use it under your own risk. 

   

# How to Run

## Account preparation 

- Deposit BUSD for trading on [SakePerp Exchange](https://www.binance.com/zh-CN/busd)
- Deposit enough USD or appropriate stablecoins on CEX exchange (Binance/FTX/Huobi/OKex), acquire the API which is allowed for perpetual contract trading.

## Download

```bash
$ git clone https://github.com/Sakeswap/sakeperp-arbitrageur.git
$ cd sakeperp-arbitrageur
```

## Configuration

Provide your private keys using the SakePerp and API from CEX in `config/.env.production`:

```bash
WEB3_ENDPOINT=wss://bsc-ws-node.nariox.org:443
# The private key must start with "0x" - add it if necessary (e.g. from private key exported from Metamask)
ARBITRAGEUR_PK=YOUR_WALLET_PRIVATE_KEY

# binance/ftx/huobi/okex
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
**Notes:**

1. The default `WEB3_ENDPOINT` in`.env.production` is from Binance official which is not stable enough , it's highly recommended to set up your own BSC node or buy services from 3rd party.
   1. QuikNode : [https://quiknode.io](https://quiknode.io/)
   2. ANKR: https://app.ankr.com/api
   3. GetBlock.io: https://getblock.io/nodes/bsc

2.  `sakeperp-arbitrageur` supports 4 CEX exchanges: [Binance](https://www.binance.com/), [FTX](https://ftx.com/), [Huobi](https://www.huobi.com/) and [OKex](https://www.okex.com/), choose one as you like.



Edit the trading parameters in `config/config.json`:

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
            "SAKEPERP_SHORT_ENTRY_TRIGGER": 0.005,  // open the short position at Perp exchange when the spread is >= 0.5 % 
            "SAKEPERP_LONG_ENTRY_TRIGGER": -0.005,  // open the long position at Perp exchange when the spread is =< -0.5%
            "ADJUST_MARGIN_RATIO_THRESHOLD": 0.1,
            "MAX_SLIPPAGE_RATIO": 0.001,  // set the max slippage ratio limit to avoid large slippage 
            "CEX_MARKET_ID": "BTC-USDT",  // perpetual pair name in Binance/FTX/Huobi/OKex.
            "CEX_MIN_TRADE_SIZE": 0.001   
        },
        .....
     ]
}
```

**Notes:**

1. `CEX_MARKET_ID` in different CEX is different , use the correct name with your CEX.
2. Read [config/config.json](https://github.com/Sakeswap/sakeperp-arbitrageur/blob/main/config/config.json) and [src/Arbitrageur.ts](https://github.com/Sakeswap/sakeperp-arbitrageur/blob/main/src/Arbitrageur.ts) for more details.

## Run

You can run `sakeperp-arbitrageur` in two ways:

### 1.npm

```bash
$ npm install
$ npm run build
$ npm run arbitrage
```

### 2.Docker

build a docker image:
```
docker build -t  sakeperp/arbitrageur  .
```

create a new folder
```
mkdir sakeperp-arbitrageur
cd  sakeperp-arbitrageur
```

copy `.env.production` and `config.json` file in the /config folder to the new folder and create a docker-compose.yml file in the same folder：
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

start a docker container：
```
docker-compose up -d
```
if change the `config.json`, please restart docker container

## Feedback

Any bugs or updates, please open Issues or PRs, Many Thanks.