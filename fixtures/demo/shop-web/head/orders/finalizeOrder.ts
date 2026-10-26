import { applyDiscounts } from "../pricing/applyDiscounts.ts";
import { PromoCache } from "../promo/PromoCache.ts";

export function finalizeOrder(cart, shopper, state) {
	const total = PromoCache.get(cart.id) ?? applyDiscounts(cart, shopper, cart.code, state);
	PromoCache.set(cart.id, total);
	return { id: cart.id, total, promoCode: cart.code, discountTotal: cart.subtotal - total };
}
