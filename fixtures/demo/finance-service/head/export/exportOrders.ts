// Depends on shop-web #1284 migration 0047_order_promo.sql.
export function exportOrders(database) {
	return database.prepare("SELECT id, total, discount_total, promo_code FROM orders").all();
}
