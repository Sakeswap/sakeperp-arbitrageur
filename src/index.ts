import "./init" // this import is required
import { Container } from "typedi"
import { Arbitrageur } from "./Arbitrageur"

(async () => {
    const arbitrageur = Container.get(Arbitrageur)
    await arbitrageur.startInterval()
})()
