import assert from "node:assert/strict";
import { test } from "node:test";
import { persistentDataPath } from "./identity";

test("MuseFocus keeps existing app data and respects isolated or explicitly selected profiles", () => {
	const appData = "/Users/example/Library/Application Support";
	assert.equal(persistentDataPath(`${appData}/MuseFocus`, appData), `${appData}/MetaHackathon`);
	for (const current of [
		`${appData}/MetaHackathon`,
		"/tmp/owned-test/profile",
		"/custom/muse-data",
	])
		assert.equal(persistentDataPath(current, appData), current);
});
