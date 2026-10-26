export const promos = {
	get(code, state) {
		const percent = code === "VIP30" ? 30 : code === "SPRING15" ? 15 : undefined;
		if (percent === undefined) throw new Error("Error 422");
		return { code, percent, expired: state.expired === true };
	},
};
