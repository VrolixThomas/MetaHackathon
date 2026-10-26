export function price(cart, percent) {
	return Math.round(cart.subtotal * (100 - percent)) / 100;
}
