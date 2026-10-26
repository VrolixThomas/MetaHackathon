import { promos } from "../promo/PromoRepository.ts";
import { trace } from "../scenarios/trace.ts";
import { price } from "./price.ts";

export function applyDiscounts(cart, shopper, code, state = {}) {
	const loyaltyPct = shopper.loyalty?.percent ?? 0;
	trace("loyalty", "pricing/applyDiscounts.ts", "const loyaltyPct", "Read loyalty discount", {
		loyaltyPct,
	});
	if (!code) return price(cart, loyaltyPct);
	const promo = promos.get(code, state);
	trace("promo", "pricing/applyDiscounts.ts", "const promo =", "Load promo code", promo);
	if (promo.expired) {
		trace(
			"expired",
			"pricing/applyDiscounts.ts",
			"if (promo.expired)",
			"Skip expired code",
			{ loyaltyPct },
			"return"
		);
		return price(cart, loyaltyPct);
	}
	trace(
		"discount",
		"pricing/applyDiscounts.ts",
		"price(cart, promo.percent)",
		"Promo replaces loyalty",
		{ discountPct: promo.percent }
	);
	return price(cart, promo.percent);
}
