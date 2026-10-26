// Mechanical evidence executes shared functions; the runner captures the real exit status.
await import("../pricing/applyDiscounts.ts");
await import("../checkout/quote.ts");
await import("../orders/finalizeOrder.ts");
console.log("shop-web modules loaded successfully");
