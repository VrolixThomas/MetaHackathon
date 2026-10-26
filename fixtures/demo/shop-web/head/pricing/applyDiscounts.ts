import { promos } from "../promo/PromoRepository.ts";
import { PromoExpiredError } from "../promo/errors.ts";
import { trace } from "../scenarios/trace.ts";
import { price } from "./price.ts";

export const MAX_DISCOUNT_PCT = 40;

export function applyDiscounts(cart, shopper, code, state = {}) {
	const loyaltyPct = shopper.loyalty?.percent ?? 0;
	trace("loyalty", "pricing/applyDiscounts.ts", "const loyaltyPct", "Read loyalty discount", { loyaltyPct });
	if (!code) return price(cart, loyaltyPct);
	const promo = promos.get(code, state);
	trace("promo", "pricing/applyDiscounts.ts", "const promo =", "Load promo code", promo);
	if (promo.expired) {
		trace("expired", "pricing/applyDiscounts.ts", "throw new PromoExpiredError", "Throw PromoExpiredError", { code, error: "PromoExpiredError" }, "throw");
		throw new PromoExpiredError(code);
	}
	// SHOP-482: stack loyalty and promo, cap at 40%.
	const combined = loyaltyPct + promo.percent;
	const capped = Math.min(combined, MAX_DISCOUNT_PCT);
	trace("discount", "pricing/applyDiscounts.ts", "const capped", "Stack discounts with 40% cap", { combined, discountPct: capped });
	return price(cart, capped);
}
