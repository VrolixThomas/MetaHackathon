import { applyDiscounts } from "../pricing/applyDiscounts.ts";
import { trace } from "../scenarios/trace.ts";

export function cartReminder(carts, sent, state) {
	for (const cart of carts) {
		trace("reminder", "jobs/cartReminder.ts", "const total =", "Price abandoned cart", {
			cartId: cart.id,
			subtotal: cart.subtotal,
			code: cart.code,
		});
		const total = applyDiscounts(cart, cart.shopper, cart.code, state);
		sent.push({ cartId: cart.id, total });
		trace(
			"sent",
			"jobs/cartReminder.ts",
			"sent.push",
			"Send reminder and continue batch",
			{ cartId: cart.id, total },
			"return"
		);
	}
}
