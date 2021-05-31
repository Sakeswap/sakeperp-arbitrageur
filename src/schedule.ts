import "./init" // this import is required
import { Container } from "typedi"
import { Arbitrageur } from "./Arbitrageur"

module.exports.handler = async (): Promise<void> => {
    const arbitrageur = Container.get(Arbitrageur)
    await arbitrageur.start()
}
