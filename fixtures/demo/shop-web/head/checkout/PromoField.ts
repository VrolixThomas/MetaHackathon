// Deliberate review findings: raw invalid-code message and wrapping cap note.
export function PromoField(quote) {
	return `<section class="summary"><h1>Checkout</h1>
<p>Subtotal <strong>€120.00</strong></p>
<p>Loyalty, Platinum <strong>−€24.00</strong></p>
<p>VIP30 × <strong>−€24.00</strong></p>
${quote.capped ? '<p class="cap-note" data-preview-marker="cap-note">Discounts are capped at 40% of your order.</p>' : ''}
<label>Add a promo code <input name="promo" value="VIP30" /></label><button>Apply</button>
<p>Total <strong>€${quote.total.toFixed(2)}</strong></p>
<label>Delivery instructions <input name="deliveryInstructions" /></label>
<button class="pay" data-preview-marker="pay-button">Pay €${quote.total.toFixed(2)}</button></section>`;
}
