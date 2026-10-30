// ROOT ONLY actual SQLite verification, after root bundles the standalone adapter:
// bun build src/main/db/knowledge-store.ts --target=node --format=cjs --outfile=out/knowledge-store.cjs
// ELECTRON_RUN_AS_NODE=1 electron src/main/knowledge-store-smoke.cjs --root-run out/knowledge-store.cjs
// AUTHOR ONLY: node --check this-file; node this-file --self-check.
// No app/window/provider/microphone is created. All records are controlled test inputs.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const NOW = "2026-10-31T00:00:00.000Z";
const SECRET = "REJECTED_PRIVATE_BODY_MUST_NEVER_BE_STORED";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actor = (workspaceId = "w1") => ({ workspaceId, userId: "alice", agentId: "alice-agent" });
const source = (workspaceId = "w1", patch = {}) => ({
	workspaceId,
	sourceId: "source",
	revision: "r1",
	sequence: 1,
	kind: "slack-public-channel",
	containerId: "channel",
	authorUserId: "alice",
	ownerUserId: null,
	audience: { kind: "workspace" },
	observedAt: NOW,
	state: "active",
	text: "Token A_% Blue. Emoji 🌊. Quote ' and SQL -- are literal text.",
	citation: null,
	...patch,
});
const fact = (workspaceId = "w1", patch = {}) => ({
	id: "fact",
	workspaceId,
	createdBy: actor(workspaceId),
	createdAt: NOW,
	scope: { kind: "company" },
	category: "decision",
	title: "Controlled decision",
	text: source().text,
	basis: { kind: "recorded", source: { sourceId: "source", revision: "r1" } },
	sources: [{ sourceId: "source", revision: "r1" }],
	parentFactIds: [],
	supersedes: [],
	contradicts: [],
	...patch,
});
const message = (workspaceId = "w1", patch = {}) => ({
	id: "message",
	workspaceId,
	sender: actor(workspaceId),
	requestId: "request",
	recipientAgentId: "bob-agent",
	recipientUserId: "bob",
	text: "Controlled source-backed message",
	sources: [{ sourceId: "source", revision: "r1" }],
	parentFactIds: [],
	createdAt: NOW,
	contentRole: "untrusted-evidence",
	payloadDigest: digest("controlled request"),
	...patch,
});
const audit = (value = message(), result = { status: "admitted", messageId: value.id }) => ({
	workspaceId: value.workspaceId,
	sender: value.sender,
	requestId: value.requestId,
	recipientAgentId: value.recipientAgentId,
	at: NOW,
	result,
	payloadDigest: value.payloadDigest,
});
function accepted(tx, value = message()) {
	tx.insertMessage(value);
	tx.appendAudit(audit(value));
}
function selfCheck() {
	assert.notEqual(source("w1").workspaceId, source("w2").workspaceId);
	assert.equal(fact().createdBy.workspaceId, fact().workspaceId);
	assert.equal(message().sender.workspaceId, message().workspaceId);
	assert.equal(audit().result.messageId, message().id);
	assert.match(audit().payloadDigest, /^[a-f0-9]{64}$/);
	assert.equal(JSON.stringify(audit(message("w1", { text: SECRET }))).includes(SECRET), false);
	assert.equal(
		Object.keys(require.cache).some((path) => /better-sqlite3|electron/.test(path)),
		false
	);
	process.stdout.write("Knowledge store author self-check passed; actual SQLite was not loaded.\n");
}

async function rootRun(adapterPath) {
	assert(adapterPath, "Pass root's standalone CommonJS adapter bundle");
	const { KnowledgeStore, KNOWLEDGE_STORE_MIGRATION_SQL, KNOWLEDGE_STORE_LIMITS } = require(
		resolve(adapterPath)
	);
	// Native module loading belongs exclusively to root's explicitly selected runtime/ABI.
	const SQLite = require("better-sqlite3");
	const directory = fs.mkdtempSync(join(tmpdir(), "muse-knowledge-sqlite-"));
	const connections = [];
	const open = (name) => {
		const db = new SQLite(join(directory, `${name}.sqlite`), { timeout: 0 });
		connections.push(db);
		return db;
	};
	const migrated = (name) => {
		const db = open(name);
		db.exec(KNOWLEDGE_STORE_MIGRATION_SQL);
		return { db, store: new KnowledgeStore(db) };
	};
	const count = (db, table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
	const checks = [];
	try {
		const db = open("durable");
		const store = new KnowledgeStore(db);
		assert.equal(
			db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'knowledge_%'").get()
				.count,
			0,
			"Construction must not apply migrations or own the database lifecycle"
		);
		db.exec(
			"CREATE TABLE unrelated_root_data(value TEXT); INSERT INTO unrelated_root_data VALUES('retain');"
		);
		db.exec(KNOWLEDGE_STORE_MIGRATION_SQL);
		db.exec(KNOWLEDGE_STORE_MIGRATION_SQL);
		for (const workspace of ["w1", "w2"])
			await store.transaction(workspace, (tx) => {
				tx.putSource(source(workspace));
				tx.insertFact(fact(workspace));
				accepted(tx, message(workspace));
			});
		assert.equal(db.prepare("SELECT value FROM unrelated_root_data").get().value, "retain");
		checks.push("existing-connection-additive-migration");

		for (const workspace of ["w1", "w2"])
			await store.transaction(workspace, (tx) => {
				assert.equal(tx.getSource("source").workspaceId, workspace);
				assert.equal(tx.getFact("fact").workspaceId, workspace);
				assert.equal(tx.getMessageByRequest("alice-agent", "request").workspaceId, workspace);
				assert.equal(tx.listMessages("bob-agent", 50).length, 1);
				assert.equal(tx.listMessages("unknown-agent", 50).length, 0);
				assert.equal(
					tx.queryFacts({ scope: { kind: "company" }, text: "A_%", limit: 50 }).length,
					1
				);
				assert.equal(
					tx.queryFacts({ scope: { kind: "company" }, text: "token", limit: 50 }).length,
					0
				);
				assert.equal(
					tx.queryFacts({ scope: { kind: "company" }, text: "A_Z", limit: 50 }).length,
					0
				);
				assert.equal(
					tx.queryFacts({ scope: { kind: "company" }, text: "🌊", limit: 50 }).length,
					1
				);
				assert.equal(
					tx.queryFacts({ scope: { kind: "company" }, text: "' OR 1=1 --", limit: 50 }).length,
					0
				);
			});
		await store.transaction("w1", (tx) =>
			tx.insertFact(fact("w1", { id: "private", scope: { kind: "private", ownerUserId: "alice" } }))
		);
		assert.equal(
			(
				await store.transaction("w1", (tx) =>
					tx.queryFacts({
						scope: { kind: "private", ownerUserId: "bob" },
						text: "Token",
						limit: 50,
					})
				)
			).length,
			0
		);
		assert.equal(await store.transaction("w2", (tx) => tx.getFact("private")), null);
		checks.push("workspace-identity-scope-literal-query");

		for (const write of [
			(tx) => tx.putSource(source("w2", { sourceId: "cross" })),
			(tx) => tx.insertFact(fact("w2", { id: "cross" })),
			(tx) => tx.insertFact(fact("w1", { id: "cross", createdBy: actor("w2") })),
			(tx) => accepted(tx, message("w2", { id: "cross", requestId: "cross" })),
			(tx) =>
				tx.appendAudit(audit(message("w2"), { status: "rejected", reason: "not-authorized" })),
			(tx) => tx.insertFact({ ...fact("w1", { id: "unknown-key" }), secret: SECRET }),
			(tx) => tx.putSource(source("w1", { sourceId: "invalid-dm", kind: "slack-dm" })),
			(tx) =>
				tx.insertMessage({
					...message("w1", { id: "bad-message", requestId: "bad-message" }),
					contentRole: "instruction",
				}),
		])
			await assert.rejects(store.transaction("w1", write));
		await assert.rejects(
			store.transaction("w1", (tx) => tx.insertFact(fact())),
			/Knowledge storage/
		);
		await assert.rejects(
			store.transaction("w1", (tx) =>
				accepted(tx, message("w1", { id: "another-id", text: SECRET }))
			),
			/Knowledge storage/
		);
		await store.transaction("w1", (tx) =>
			accepted(
				tx,
				message("w1", { id: "other-sender", sender: { ...actor(), agentId: "other-agent" } })
			)
		);
		checks.push("strict-shapes-cross-workspace-and-immutable-uniqueness");

		const detachedInput = fact("w1", { id: "detached" });
		let handle;
		const saving = store.transaction("w1", (tx) => {
			handle = tx;
			tx.insertFact(detachedInput);
			return {
				source: tx.getSource("source"),
				fact: tx.getFact("detached"),
				inbox: tx.listMessages("bob-agent", 50),
			};
		});
		detachedInput.text = "Caller mutated immediately after invoking transaction";
		const detached = await saving;
		detached.source.text = "Changed clone";
		detached.fact.sources[0].revision = "changed-clone";
		detached.inbox[0].text = "Changed clone";
		await store.transaction("w1", (tx) => {
			assert.equal(tx.getSource("source").text, source().text);
			assert.equal(tx.getFact("detached").text, fact().text);
			assert.equal(tx.getFact("detached").sources[0].revision, "r1");
			assert.equal(tx.getMessageByRequest("alice-agent", "request").text, message().text);
		});
		assert.throws(() => handle.putSource(source("w1", { sourceId: "expired-handle" })));
		let expiredAfterAwait = false;
		await assert.rejects(
			store.transaction("w1", async (tx) => {
				tx.putSource(source("w1", { sourceId: "async-before" }));
				await Promise.resolve();
				assert.throws(() => tx.putSource(source("w1", { sourceId: "async-after" })));
				expiredAfterAwait = true;
			}),
			/synchronous/
		);
		assert(expiredAfterAwait);
		await assert.rejects(
			store.transaction("w1", (tx) => {
				tx.putSource(source("w1", { sourceId: "promise-body" }));
				return Promise.reject(Error("Controlled rejected callback"));
			}),
			/synchronous/
		);
		await store.transaction("w1", (tx) => {
			for (const id of ["expired-handle", "async-before", "async-after", "promise-body"])
				assert.equal(tx.getSource(id), null);
		});
		checks.push("detached-clones-synchronous-callback-expired-handles");

		const beforeMessages = count(db, "knowledge_messages");
		const beforeAudits = count(db, "knowledge_audits");
		const pending = message("w1", { id: "atomic", requestId: "atomic" });
		const fenceFailure = Error("Controlled final authorization fence rejection");
		await assert.rejects(
			store.transaction("w1", (tx) => {
				accepted(tx, pending);
				throw fenceFailure;
			}),
			(error) => error === fenceFailure
		);
		await assert.rejects(
			store.transaction("w1", (tx) => tx.insertMessage(pending)),
			/Knowledge storage/
		);
		db.exec(
			"CREATE TEMP TRIGGER reject_knowledge_audit BEFORE INSERT ON knowledge_audits BEGIN SELECT RAISE(ABORT,'controlled audit failure'); END;"
		);
		await assert.rejects(
			store.transaction("w1", (tx) => {
				tx.insertMessage(pending);
				// Even a callback catching the SQL failure cannot commit an unaudited message.
				assert.throws(() => tx.appendAudit(audit(pending)));
			}),
			/Knowledge storage/
		);
		db.exec("DROP TRIGGER reject_knowledge_audit");
		assert.equal(count(db, "knowledge_messages"), beforeMessages);
		assert.equal(count(db, "knowledge_audits"), beforeAudits);
		await assert.rejects(
			store.transaction("w1", (tx) =>
				tx.appendAudit({
					...audit(message("w1", { text: SECRET }), {
						status: "rejected",
						reason: "not-authorized",
					}),
					text: SECRET,
				})
			),
			/Knowledge storage/
		);
		await store.transaction("w1", (tx) =>
			tx.appendAudit(
				audit(
					message("w1", {
						requestId: "rejected-private",
						text: SECRET,
						payloadDigest: digest(SECRET),
					}),
					{ status: "rejected", reason: "not-authorized" }
				)
			)
		);
		for (const table of [
			"knowledge_sources",
			"knowledge_facts",
			"knowledge_messages",
			"knowledge_audits",
		])
			assert.equal(
				db.prepare(`SELECT count(*) AS count FROM ${table} WHERE instr(data_json,?)>0`).get(SECRET)
					.count,
				0
			);
		checks.push("atomic-message-audit-final-fence-and-rejected-payload-redaction");

		for (const kind of ["supersedes", "contradicts"]) {
			const target = `target-${kind}`;
			await store.transaction("w1", (tx) => {
				tx.insertFact(fact("w1", { id: target }));
				for (let index = 0; index < 256; index++)
					tx.insertFact(fact("w1", { id: `${kind}-${index}`, [kind]: [target, target] }));
			});
			await store.transaction("w2", (tx) =>
				tx.insertFact(fact("w2", { id: `foreign-${kind}`, [kind]: [target] }))
			);
			const key = kind === "supersedes" ? "supersededBy" : "contradictedBy";
			assert.equal(
				(await store.transaction("w1", (tx) => tx.getRelatedFactIds(target)))[key].length,
				256
			);
			await store.transaction("w1", (tx) =>
				tx.insertFact(fact("w1", { id: `overflow-${kind}`, [kind]: [target] }))
			);
			await assert.rejects(
				store.transaction("w1", (tx) => tx.getRelatedFactIds(target)),
				/Knowledge storage/
			);
		}
		checks.push("complete-reverse-edges-256-bound-and-workspace-isolation");

		await store.transaction("w1", (tx) =>
			tx.putSource(source("w1", { sequence: 2, state: "revoked", text: source().text }))
		);
		assert.equal((await store.transaction("w1", (tx) => tx.getSource("source"))).text, null);
		await store.transaction("w1", (tx) =>
			tx.putSource(
				source("w1", { sequence: 3, revision: "deleted-r3", state: "deleted", text: source().text })
			)
		);
		const tombstone = await store.transaction("w1", (tx) => tx.getSource("source"));
		assert.equal(tombstone.sequence, 3);
		assert.equal(tombstone.text, null);
		await assert.rejects(
			store.transaction("w1", (tx) => tx.putSource(source("w1", { sequence: 2 })))
		);
		await assert.rejects(
			store.transaction("w1", (tx) => tx.putSource(source("w1", { sequence: 4 })))
		);
		assert.equal(
			JSON.parse(
				db
					.prepare("SELECT data_json FROM knowledge_sources WHERE workspace_id=? AND source_id=?")
					.get("w1", "source").data_json
			).text,
			null
		);
		db.close();
		const reopenedDb = open("durable");
		const reopened = new KnowledgeStore(reopenedDb);
		assert.deepEqual(await reopened.transaction("w1", (tx) => tx.getSource("source")), tombstone);
		assert.equal(
			(await reopened.transaction("w1", (tx) => tx.getMessageByRequest("alice-agent", "request")))
				.id,
			"message"
		);
		assert.equal((await reopened.transaction("w2", (tx) => tx.getFact("fact"))).workspaceId, "w2");
		checks.push("logical-tombstone-purge-monotonic-fence-and-reconnect");

		const other = open("durable");
		await reopened.transaction("w1", () => {
			assert.throws(
				() =>
					other
						.prepare("INSERT INTO unrelated_root_data VALUES(?)")
						.run("blocked concurrent write"),
				/locked/
			);
		});
		other.prepare("INSERT INTO unrelated_root_data VALUES(?)").run("allowed after commit");
		checks.push("immediate-transaction-cross-connection-serialization");

		const bounded = migrated("bounds");
		const citationSource = {
			provider: "slack",
			workspaceId: "bound",
			conversationId: "channel",
			messageId: "timestamp",
			threadId: null,
			revisionId: "r1",
			permalink: null,
		};
		const oversized = source("bound", {
			sourceId: `slack:${digest(["slack", "bound", "channel", "timestamp"])}`,
			citation: {
				source: citationSource,
				audience: {
					workspaceId: "bound",
					conversationId: "channel",
					visibility: "public_channel",
					readerIds: Array.from({ length: 6000 }, (_, index) => `${index}-${"r".repeat(100)}`),
					membershipRevision: "members-r1",
					observedAt: NOW,
				},
			},
		});
		assert(Buffer.byteLength(JSON.stringify(oversized)) > KNOWLEDGE_STORE_LIMITS.rowBytes);
		await assert.rejects(bounded.store.transaction("bound", (tx) => tx.putSource(oversized)));
		assert.equal(count(bounded.db, "knowledge_sources"), 0);
		bounded.db.transaction(() => {
			const insert = bounded.db.prepare(
				"INSERT INTO knowledge_sources(workspace_id,source_id,sequence,data_json) VALUES(?,?,?,?)"
			);
			for (let index = 0; index < KNOWLEDGE_STORE_LIMITS.sources; index++) {
				const value = source("bound", { sourceId: `bounded-${index}` });
				insert.run("bound", value.sourceId, value.sequence, JSON.stringify(value));
			}
		})();
		await assert.rejects(
			bounded.store.transaction("bound", (tx) =>
				tx.putSource(source("bound", { sourceId: "overflow" }))
			)
		);
		assert.equal(count(bounded.db, "knowledge_sources"), KNOWLEDGE_STORE_LIMITS.sources);
		for (let index = 1; index < KNOWLEDGE_STORE_LIMITS.workspaces; index++)
			await bounded.store.transaction(`workspace-${index}`, (tx) =>
				tx.putSource(source(`workspace-${index}`))
			);
		await assert.rejects(
			bounded.store.transaction("workspace-overflow", (tx) =>
				tx.putSource(source("workspace-overflow"))
			)
		);
		checks.push("json-byte-row-count-and-workspace-count-bounds");

		const corrupt = migrated("corrupt");
		await corrupt.store.transaction("w1", (tx) => tx.insertFact(fact()));
		corrupt.db
			.prepare("UPDATE knowledge_facts SET data_json=? WHERE workspace_id=? AND fact_id=?")
			.run(JSON.stringify(fact("w2")), "w1", "fact");
		await assert.rejects(corrupt.store.transaction("w1", (tx) => tx.getFact("fact")));
		assert.equal(
			count(corrupt.db, "knowledge_facts"),
			1,
			"Invalid stored records must be retained for root recovery"
		);
		checks.push("stored-key-corruption-fails-closed-without-erasure");
		process.stdout.write(
			`${JSON.stringify({ ok: true, checks, proof: "Actual better-sqlite3 on temporary files; controlled records only. No app, provider or fresh-authority integration verification." })}\n`
		);
	} finally {
		for (const db of connections) if (db.open) db.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--self-check") selfCheck();
else if (process.argv[2] === "--root-run")
	rootRun(process.argv[3]).catch((error) => {
		process.stderr.write(`${error.stack ?? error}\n`);
		process.exitCode = 1;
	});
else {
	process.stderr.write(
		"Use --self-check (author) or --root-run <standalone-adapter.cjs> (root only).\n"
	);
	process.exitCode = 1;
}
