/**
 * Usage-cache identity contracts:
 *
 *   1. Every fetched report is annotated with the credential's usage-cache
 *      identity — a one-way secret fingerprint when the account has no stable
 *      id — regardless of whether the fetching path knew the stored row id.
 *      The raw key bytes never appear in the report or its cache entry.
 *   2. `getSessionUsageCacheIdentity` resolves the session-sticky credential
 *      (including reference-style stored keys) to the same fingerprint, so
 *      status surfaces can match reports to the active account even when the
 *      `credentialId` annotation was lost to a shared-cache rewrite.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

function openCodeGoReport(percent5h: number): UsageReport {
	return {
		provider: "opencode-go",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "rolling-5h",
				label: "5 Hour limit",
				scope: { provider: "opencode-go", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
				amount: {
					unit: "percent",
					used: percent5h,
					usedFraction: percent5h / 100,
					remainingFraction: 1 - percent5h / 100,
				},
				status: percent5h >= 100 ? "exhausted" : "ok",
			},
		],
	};
}

describe("AuthStorage usage-cache identity", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByKey = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "opencode-go",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;
			return usageByKey.get(apiKey) ?? null;
		},
		supports: params => params.provider === "opencode-go" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-usage-identity-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "opencode-go" ? usageProvider : undefined),
			async configValueResolver(config) {
				if (config === "GO_ACTIVE_REF") return "go-active-secret";
				return config;
			},
		});
		usageByKey.clear();
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("annotates fetched reports with the cache identity fingerprint, never the raw key", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("opencode-go", [
			{ type: "api_key", key: "go-key-a", source: "login" },
			{ type: "api_key", key: "go-key-b", source: "login" },
		]);
		usageByKey.set("go-key-a", openCodeGoReport(30));
		usageByKey.set("go-key-b", openCodeGoReport(60));

		const reports = await authStorage.fetchUsageReports();
		expect(reports).not.toBeNull();
		const goReports = (reports ?? []).filter(report => report.provider === "opencode-go");
		expect(goReports).toHaveLength(2);

		const [reportA, reportB] = goReports;
		expect(reportA.metadata?.usageCacheIdentity).toBe(`api_key|secret:${Bun.hash("go-key-a").toString(16)}`);
		expect(reportB.metadata?.usageCacheIdentity).toBe(`api_key|secret:${Bun.hash("go-key-b").toString(16)}`);
		expect(reportA.metadata?.credentialId).toBe(1);
		expect(reportB.metadata?.credentialId).toBe(2);

		const serialized = JSON.stringify(reports);
		expect(serialized).not.toContain("go-key-a");
		expect(serialized).not.toContain("go-key-b");
	});

	test("resolves the sticky credential's cache identity without exposing the key", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("opencode-go", [{ type: "api_key", key: "GO_ACTIVE_REF", source: "login" }]);

		expect(await authStorage.getSessionUsageCacheIdentity("opencode-go", "session-1")).toBeUndefined();

		const resolved = await authStorage.getApiKey("opencode-go", "session-1");
		expect(resolved).toBe("go-active-secret");

		const identity = await authStorage.getSessionUsageCacheIdentity("opencode-go", "session-1");
		expect(identity).toBe(`api_key|secret:${Bun.hash("go-active-secret").toString(16)}`);
		expect(identity).not.toContain("go-active-secret");
	});
});
