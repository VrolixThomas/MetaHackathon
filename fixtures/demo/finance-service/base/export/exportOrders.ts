export function exportOrders(database) {
	return database.prepare("SELECT id, total, discount_total FROM orders").all();
}
