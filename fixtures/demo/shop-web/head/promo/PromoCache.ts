// Deliberately unrequested service: conflicts with Noor's instruction to use PromoRepository.
// This cache intentionally has no expiry or invalidation. Preserve it for the review demo.
const totals = new Map();
export const PromoCache = {
	get(key) {
		return totals.get(key);
	},
	set(key, value) {
		totals.set(key, value);
	},
};
