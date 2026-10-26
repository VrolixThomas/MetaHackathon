import { applyDiscounts } from "../pricing/applyDiscounts.ts";
import { cartReminder } from "../jobs/cartReminder.ts";
import { finalizeOrder } from "../orders/finalizeOrder.ts";

const scenario = process.argv[2] ?? "C";
const sent = [];
let result;
try {
	if (scenario === "C") {
		const shopper = { loyalty: { percent: 10 } };
		cartReminder([
			{ id: "abandoned-1", subtotal: 120, code: "SPRING15", shopper },
			{ id: "abandoned-2", subtotal: 80, shopper },
		], sent, { expired: true });
		result = { sent, batchStopped: false };
	} else if (scenario === "A" || scenario === "B") {
		const loyalty = scenario === "A" ? 10 : 20;
		const code = scenario === "A" ? "SPRING15" : "VIP30";
		result = { total: applyDiscounts({ subtotal: 120 }, { loyalty: { percent: loyalty } }, code) };
	} else if (scenario === "D") {
		const cart = { id: "checkout-1", subtotal: 120, code: "SPRING15" };
		result = { quoted: applyDiscounts(cart, { loyalty: { percent: 10 } }, cart.code), paid: finalizeOrder(cart, { loyalty: { percent: 0 } }).total };
	} else throw new Error("Unknown scenario");
} catch (error) {
	result = { error: error.name, message: error.message, sent, batchStopped: scenario === "C" };
}
console.log(`METAHACKATHON_RESULT ${JSON.stringify(result)}`);
