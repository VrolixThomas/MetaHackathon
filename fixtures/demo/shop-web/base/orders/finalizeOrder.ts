import { applyDiscounts } from "../pricing/applyDiscounts.ts";

export function finalizeOrder(cart, shopper, state) {
	const total = applyDiscounts(cart, shopper, cart.code, state);
	return { id: cart.id, total, discountTotal: cart.subtotal - total };
}
