// Deliberate review findings: raw invalid-code message and wrapping cap note.
export function PromoField(quote) {
	return `<section class="summary"><h1>Checkout</h1>
<p>Subtotal <strong>€120.00</strong></p>
<p>Loyalty, Platinum <strong>−€24.00</strong></p>
<p>${quote.code || "No promo"} × <strong>−€${Math.max(0, 96 - quote.total).toFixed(2)}</strong></p>
${quote.capped ? '<p class="cap-note" data-preview-marker="cap-note">Discounts are capped at 40% of your order.</p>' : ""}
<form method="get" action="/checkout"><input type="hidden" name="runId" value="${quote.runId}" />
<label>Add a promo code <input name="promo" value="${quote.code}" /></label><button type="submit">Apply</button>
${quote.error ? `<p role="alert">${quote.error}</p>` : ""}
<p>Total <strong>€${quote.total.toFixed(2)}</strong></p>
<label>Delivery instructions <input name="deliveryInstructions" /></label>
<button class="pay" data-preview-marker="pay-button" name="pay" value="1">Pay €${quote.total.toFixed(2)}</button>
${quote.paid ? '<p role="status">Demo order received. No payment was taken.</p>' : ""}</form></section>`;
}
