import { applyDiscounts } from "../pricing/applyDiscounts.ts";

export function quote(cart, shopper, state) {
	return applyDiscounts(cart, shopper, cart.code, state);
}
