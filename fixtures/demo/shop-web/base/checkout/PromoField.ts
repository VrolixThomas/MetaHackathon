export function PromoField(quote) {
	return `<section class="summary"><h1>Checkout</h1>
<p>Subtotal <strong>€120.00</strong></p><p>Promo replaces loyalty</p>
<form method="get" action="/checkout"><input type="hidden" name="runId" value="${quote.runId}" />
<label>Promo code <input name="promo" value="${quote.code}" /></label><button type="submit">Apply</button>
${quote.error ? `<p role="alert">${quote.error}</p>` : ""}
<p>Total <strong>€${quote.total.toFixed(2)}</strong></p>
<label>Delivery instructions <input name="deliveryInstructions" /></label>
<button class="pay" data-preview-marker="pay-button" name="pay" value="1">Pay €${quote.total.toFixed(2)}</button>
${quote.paid ? '<p role="status">Demo order received. No payment was taken.</p>' : ""}</form></section>`;
}
