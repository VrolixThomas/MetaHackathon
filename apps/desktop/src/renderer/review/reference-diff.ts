import { type ReviewFile, parseDiff } from "./model";

// Code excerpts transcribed from the design reference, never executed evidence.
// Metadata and artifacts use the integration lane's shared fixture when available.
const discountsBefore = `import { promos } from '../promo/PromoRepository';
import { PromoExpiredError } from '../promo/errors';
import { price } from './price';

export const MAX_DISCOUNT_PCT = 40;

export function applyDiscounts(cart, shopper, code) {
  const loyaltyPct = shopper.loyalty?.percent ?? 0;
  if (!code) return price(cart, loyaltyPct);

  const promo = promos.get(code);
  if (promo.expired) return price(cart, loyaltyPct);
  return price(cart, promo.percent);
}`;
const discountsAfter = `import { promos } from '../promo/PromoRepository';
import { PromoExpiredError } from '../promo/errors';
import { price } from './price';

export const MAX_DISCOUNT_PCT = 40;

export function applyDiscounts(cart, shopper, code) {
  const loyaltyPct = shopper.loyalty?.percent ?? 0;
  if (!code) return price(cart, loyaltyPct);

  const promo = promos.get(code);
  if (promo.expired) throw new PromoExpiredError(code);

  // SHOP-482: stack loyalty and promo, cap the total
  const combined = loyaltyPct + promo.percent;
  const capped = Math.min(combined, MAX_DISCOUNT_PCT);
  return price(cart, capped);
}`;

const checkoutBefore = `export function PromoField({ quote, onApply, clear }) {
  const [code, setCode] = useState('');
  const { status, error } = usePromo(code);

  return (
    <section className="summary">
      <Line label="Subtotal" value={quote.subtotal} />
      {quote.promo && <Line label="Promo" value={-quote.promo.amount} />}
      <Total value={quote.total} />
      <PromoInput onApply={onApply} />
    </section>
  );
}`;
const checkoutAfter = `export function PromoField({ quote, onApply, clear }) {
  const [code, setCode] = useState('');
  const { status, error } = usePromo(code);

  return (
    <section className="summary">
      <Line label="Subtotal" value={quote.subtotal} />
      {quote.loyalty && <Line label="Loyalty" value={-quote.loyalty} />}
      {quote.promo && <CodeChip code={quote.promo.code} onRemove={clear} />}
      {quote.capped && (
        <p className="cap-note">Discounts are capped at 40% of your order.</p>
      )}
      <CodeInput value={code} onChange={setCode} onApply={onApply} />
      {status === 'checking' && <Hint>Checking…</Hint>}
      {error && <Hint tone="error">{error.message}</Hint>}
      <Total value={quote.total} />
    </section>
  );
}`;

function file(
	path: string,
	purpose: string,
	attention: ReviewFile["attention"],
	before: string,
	after: string
): ReviewFile {
	const lines = parseDiff(before, after);
	return {
		path,
		purpose,
		attention,
		lines,
		additions: lines.filter((l) => l.kind === "add").length,
		deletions: lines.filter((l) => l.kind === "remove").length,
	};
}

export const referenceFiles: ReviewFile[] = [
	file("pricing/applyDiscounts.ts", "The discount rule", "read", discountsBefore, discountsAfter),
	file(
		"orders/finalizeOrder.ts",
		"Where the price is locked in",
		"read",
		`export async function finalizeOrder(cart) {
  const shopper = await shoppers.get(cart.shopperId);
  const total = applyDiscounts(cart, shopper, cart.appliedCode);
  const order = await orders.create({ cartId: cart.id, total });
  await events.emit('order.priced', order);
  return order;
}`,
		`export async function finalizeOrder(cart) {
  const shopper = await shoppers.get(cart.shopperId);
  const total = applyDiscounts(cart, shopper, cart.appliedCode);
  const order = await orders.create({
    cartId: cart.id,
    total,
    promoCode: cart.appliedCode,
    discountTotal: cart.subtotal - total,
  });
  await events.emit('order.priced', order);
  return order;
}`
	),
	file(
		"migrations/0047_order_promo.sql",
		"One new column",
		"skim",
		"-- Orders retain the quoted price.",
		"-- Orders retain the quoted price.\nALTER TABLE orders ADD COLUMN promo_code TEXT;"
	),
	file("checkout/PromoField.tsx", "Checkout field", "read", checkoutBefore, checkoutAfter),
	file(
		"promo/PromoCache.ts",
		"A cache nobody asked for",
		"decide",
		"",
		`const cache = new Map();

// No invalidation policy is specified in SHOP-482.
export function getPromo(code, load) {
  if (!cache.has(code)) cache.set(code, load(code));
  return cache.get(code);
}`
	),
	file(
		"jobs/cartReminder.ts",
		"Nightly reminder · caller context",
		"context",
		`export async function remindAbandonedCarts(carts) {
  for (const cart of carts) {
    const total = applyDiscounts(cart, cart.shopper, cart.appliedCode);
    await sendReminder(cart, total);
  }
}`,
		`export async function remindAbandonedCarts(carts) {
  for (const cart of carts) {
    const total = applyDiscounts(cart, cart.shopper, cart.appliedCode);
    await sendReminder(cart, total);
  }
}`
	),
];
