import tradingJson from '../config/tradingdata.json';
import fs from 'fs-extra';
import { Service } from "typedi"
import Big from "big.js"
import { Log } from "./Log"

@Service()
export class TradingData {
	private readonly log = Log.getLogger(TradingData.name)
	private path = "./config/tradingdata.json"
 	data: Record<string, tradingStruct> = {}
	constructor() {
		fs.readFile(this.path, 'utf-8', (err, data) => {
			if (err) {
			    throw err;
			}
			// parse JSON object
			const s = JSON.parse(data.toString());
			this.log.jinfo({
				event: "Tradingdata",
				params: s,
			})
			this.data = s
		});
	}
	
	
	getTradingData(symbol: string): tradingStruct {
		const s = this.data[symbol]
		if (s) {
			return s
		}else{
			return {
				openSpread: Big(0)
			}
		}
	}

	setTradingData() {
		this.writeToFile()
	}

	private writeToFile(): void{
		this.log.jinfo({
			event: "setTradingdata",
			params: this.data,
		})
		const data = JSON.stringify(this.data);
		fs.writeFileSync(this.path, data);
	}

	private readFromFile() {

	}
	
}

export interface tradingStruct {
	openSpread: Big
}
    
    