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

	test("annotates fetched reports with credential IDs without exposing raw keys", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("opencode-go", [
			{ type: "api_key", key: "go-key-a", source: "login" },
			{ type: "api_key", key: "go-key-b", source: "login" },
		]);
		usageByKey.set("go-key-a", openCodeGoReport(30));
		usageByKey.set("go-key-b", openCodeGoReport(60));

		const reports = await authStorage.fetchUsageReports();
		const goReports = (reports ?? []).filter(report => report.provider === "opencode-go");
		expect(goReports.map(report => report.metadata?.credentialId)).toEqual([1, 2]);

		const serialized = JSON.stringify(reports);
		expect(serialized).not.toContain("go-key-a");
		expect(serialized).not.toContain("go-key-b");
	});

	test("preserves credential IDs when ranking rewrites a referenced-key cache entry", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("opencode-go", [
			{ type: "api_key", key: "GO_ACTIVE_REF", source: "login" },
			{ type: "api_key", key: "go-backup-secret", source: "login" },
		]);
		usageByKey.set("go-active-secret", openCodeGoReport(30));
		usageByKey.set("go-backup-secret", openCodeGoReport(60));

		expect(await authStorage.getApiKey("opencode-go", "session-1")).toBe("go-active-secret");

		const reports = await authStorage.fetchUsageReports();
		const goReports = (reports ?? []).filter(report => report.provider === "opencode-go");
		expect(goReports.map(report => report.metadata?.credentialId)).toEqual([1, 2]);
		expect(JSON.stringify(reports)).not.toContain("go-active-secret");
	});
});
