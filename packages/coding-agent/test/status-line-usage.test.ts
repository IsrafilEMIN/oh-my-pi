import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function makeComponent(
	reports: unknown,
	options: {
		provider?: string;
		modelId?: string;
		model?: { id?: string; contextWindow: number; provider?: string };
		activeIdentity?: { accountId?: string; email?: string; projectId?: string };
		activeCredentialId?: number;
		activeFingerprint?: string;
	} = {},
): StatusLineComponent {
	const model = options.model ?? { id: options.modelId, contextWindow: 1000, provider: options.provider };
	const component = new StatusLineComponent({
		state: { messages: [], model },
		model,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		fetchUsageReports: async () => reports,
		modelRegistry: {
			authStorage: {
				getOAuthAccountIdentity: (provider: string) =>
					provider === model.provider ? options.activeIdentity : undefined,
				getSessionCredentialId: () => options.activeCredentialId,
				getSessionUsageCacheIdentity: async () => options.activeFingerprint,
			},
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: ["usage"],
		sessionAccent: false,
	});
	return component;
}

async function flushUsageRefresh(): Promise<void> {
	const timer = Promise.withResolvers<void>();
	setTimeout(timer.resolve, 0);
	await timer.promise;
	await Promise.resolve();
	await Promise.resolve();
}

describe("usage status-line segment", () => {
	it("renders compact remaining quota for active and backup accounts", () => {
		const result = renderSegment("usage", {
			usage: [
				{ provider: "opencode-go", active: true, fiveHour: 25, sevenDay: 60, monthly: 35 },
				{ provider: "opencode-go", active: false, fiveHour: 50, sevenDay: 90, monthly: 100 },
			],
		} as unknown as SegmentContext);

		expect(stripVTControlCharacters(result.content)).toBe("GO ● 75/40/65 ○ 50/10/0");
		expect(result.visible).toBe(true);
	});

	it("masks provider and quota values in startup placeholders", () => {
		const result = renderSegment("usage", {
			startupPlaceholder: true,
			usage: [
				{ provider: "openai-codex", active: true, fiveHour: 24, sevenDay: 8 },
				{ provider: "openai-codex", active: false, fiveHour: 66 },
			],
		} as unknown as SegmentContext);

		expect(stripVTControlCharacters(result.content)).toBe("… ● …/… ○ …/…");
		expect(result.visible).toBe(true);
	});

	it("labels grok, cursor, go, and gpt providers in compact caps", () => {
		expect(
			stripVTControlCharacters(
				renderSegment("usage", {
					usage: [{ provider: "xai-oauth", active: true, fiveHour: 10, sevenDay: 20 }],
				} as unknown as SegmentContext).content,
			),
		).toBe("GROK ● 90/80");
		expect(
			stripVTControlCharacters(
				renderSegment("usage", {
					usage: [{ provider: "cursor", active: true, monthly: 6, monthlyOther: 5 }],
				} as unknown as SegmentContext).content,
			),
		).toBe("CURSOR ● 94/95");
		expect(
			stripVTControlCharacters(
				renderSegment("usage", {
					usage: [{ provider: "openai-codex", active: true, fiveHour: 24, sevenDay: 8 }],
				} as unknown as SegmentContext).content,
			),
		).toBe("GPT ● 76/92");
	});

	it("hides missing or empty usage", () => {
		expect(renderSegment("usage", { usage: null } as unknown as SegmentContext).visible).toBe(false);
		expect(renderSegment("usage", { usage: [] } as unknown as SegmentContext).visible).toBe(false);
	});

	it("keeps windows within the preferred untiered scope", async () => {
		const component = makeComponent([
			{
				provider: "anthropic",
				limits: [
					{ scope: { windowId: "5h", tier: "stale" }, amount: { usedFraction: 0.5 } },
					{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
					{ scope: { windowId: "7d", tier: "prolite" }, amount: { usedFraction: 0.08 } },
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("anthropic ● 76/?");
	});

	it("selects one coherent scope and invalidates usage when the active model changes", async () => {
		const reports = [
			{
				provider: "openai-codex",
				limits: [
					{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					{
						scope: { windowId: "5h", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0.42 },
					},
					{
						scope: { windowId: "7d", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0.11 },
					},
				],
			},
		];
		const model = { id: "gpt-5.6-sol", contextWindow: 1000, provider: "openai-codex" };
		const component = makeComponent(reports, { model });
		component.refreshUsageInBackground();
		await flushUsageRefresh();
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("GPT ● ?/92");

		model.id = "gpt-5.3-codex-spark";
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).not.toContain("GPT ● ?/92");
		await flushUsageRefresh();
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("GPT ● 58/89");
	});

	it("scopes reports to the active provider and marks only the identity match active", async () => {
		const component = makeComponent(
			[
				{
					provider: "anthropic",
					limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.99 } }],
				},
				{
					provider: "openai-codex",
					metadata: { accountId: "backup-account" },
					limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.66 } }],
				},
				{
					provider: "openai-codex",
					metadata: { accountId: "active-account" },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					],
				},
			],
			{ provider: "openai-codex", activeIdentity: { accountId: "active-account" } },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("GPT ● 76/92 ○ 34/?");
		expect(content.match(/●/g)).toHaveLength(1);
		expect(content).not.toContain("1/?");
	});

	it("orders the credential ID match before backups", async () => {
		const component = makeComponent(
			[
				{
					provider: "opencode-go",
					metadata: { credentialId: 1 },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.5 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.9 } },
						{ scope: { windowId: "monthly" }, amount: { usedFraction: 1 } },
					],
				},
				{
					provider: "opencode-go",
					metadata: { credentialId: 2 },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.25 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.6 } },
						{ scope: { windowId: "monthly" }, amount: { usedFraction: 0.35 } },
					],
				},
			],
			{ provider: "opencode-go", activeCredentialId: 2 },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("GO ● 75/40/65 ○ 50/10/0");
	});

	it("uses the usage-cache fingerprint when the credential annotation is missing", async () => {
		const component = makeComponent(
			[
				{
					provider: "opencode-go",
					metadata: { credentialId: 1, usageCacheIdentity: "api_key|secret:aaaa" },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.5 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.9 } },
						{ scope: { windowId: "monthly" }, amount: { usedFraction: 1 } },
					],
				},
				{
					provider: "opencode-go",
					metadata: { usageCacheIdentity: "api_key|secret:bbbb" },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.25 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.6 } },
						{ scope: { windowId: "monthly" }, amount: { usedFraction: 0.35 } },
					],
				},
			],
			{
				provider: "opencode-go",
				activeCredentialId: 4,
				activeFingerprint: "api_key|secret:bbbb",
			},
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("GO ● 75/40/65 ○ 50/10/0");
	});

	it("invalidates cached usage when the active provider changes", async () => {
		let provider = "openai-codex";
		const model = { contextWindow: 1000, provider };
		const reports = [
			{
				provider: "anthropic",
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } }],
			},
			{
				provider: "openai-codex",
				metadata: { accountId: "active-account" },
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.8 } }],
			},
		];
		const session = {
			state: { messages: [], model },
			model,
			sessionManager: {
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			fetchUsageReports: async () => reports,
			modelRegistry: {
				authStorage: {
					getOAuthAccountIdentity: (requestedProvider: string) =>
						requestedProvider === provider && provider === "openai-codex"
							? { accountId: "active-account" }
							: undefined,
				},
			},
			getAsyncJobSnapshot: () => ({ running: [] }),
			getContextUsage: () => undefined,
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["usage"],
			sessionAccent: false,
		});

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("GPT ● 20/?");

		provider = "anthropic";
		model.provider = provider;

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).not.toContain("GPT ● 20/?");
		await flushUsageRefresh();
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("anthropic ● 76/?");
	});

	it("renders Cursor auto and other monthly rails", async () => {
		const component = makeComponent(
			[
				{
					provider: "cursor",
					limits: [
						{ id: "legacy", scope: { windowId: "monthly" }, amount: { usedFraction: 0.7 } },
						{
							id: "cursor:usd:individual-plan",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.35 },
						},
						{
							id: "cursor:usd:individual-auto",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.06 },
						},
						{
							id: "cursor:usd:individual-api",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.05 },
						},
					],
				},
			],
			{ provider: "cursor" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("CURSOR ● 94/95");
	});

	it("renders all OpenCode Go quota windows", async () => {
		const component = makeComponent(
			[
				{
					provider: "opencode-go",
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.12 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
						{ scope: { windowId: "monthly" }, amount: { usedFraction: 0.42 } },
					],
				},
			],
			{ provider: "opencode-go" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("GO ● 88/92/58");
	});

	it("does not render unsupported monthly-only providers", async () => {
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					limits: [{ scope: { windowId: "monthly" }, amount: { usedFraction: 0.42 } }],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).not.toContain("github-copilot");
	});

	it("maps non-canonical window IDs by reported duration", async () => {
		const component = makeComponent([
			{
				provider: "anthropic",
				limits: [
					{
						scope: { windowId: "burst" },
						window: { durationMs: 5 * 3_600_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						scope: { windowId: "weekly" },
						window: { durationMs: 7 * 86_400_000 },
						amount: { usedFraction: 0.08 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("anthropic ● 76/92");
	});

	it("renders Google Antigravity daily usage", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "google-antigravity",
					limits: [
						{
							label: "Usage (Google)",
							scope: { provider: "google-antigravity", windowId: "daily" },
							window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 11 * 60_000 },
							amount: { usedFraction: 0.054 },
						},
					],
				},
			],
			{ provider: "google-antigravity" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("google-antigravity ● 95");
	});

	it("scopes Antigravity usage to the active model's backend counter", async () => {
		const now = Date.now();
		const reports = [
			{
				provider: "google-antigravity",
				limits: [
					{
						id: "google-antigravity:default:default:daily",
						label: "Usage",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 5 * 60_000 },
						amount: { usedFraction: 0.99 },
					},
					{
						id: "google-antigravity:google:default:daily",
						label: "Usage (Google)",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 11 * 60_000 },
						amount: { usedFraction: 0.91 },
					},
					{
						id: "google-antigravity:anthropic:default:daily",
						label: "Usage (Anthropic)",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 40 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						id: "google-antigravity:openai:default:daily",
						label: "Usage (OpenAI)",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 25 * 60_000 },
						amount: { usedFraction: 0.63 },
					},
				],
			},
		];

		const claude = makeComponent(reports, { provider: "google-antigravity", modelId: "claude-opus-4-6" });
		claude.refreshUsageInBackground();
		await flushUsageRefresh();
		const claudeContent = stripVTControlCharacters(claude.getTopBorder(200).content);
		expect(claudeContent).toContain("google-antigravity ● 76");
		expect(claudeContent).not.toContain("● 9");
		expect(claudeContent).not.toContain("● 1");

		const gemini = makeComponent(reports, { provider: "google-antigravity", modelId: "gemini-3-pro" });
		gemini.refreshUsageInBackground();
		await flushUsageRefresh();
		const geminiContent = stripVTControlCharacters(gemini.getTopBorder(200).content);
		expect(geminiContent).toContain("google-antigravity ● 9");
		expect(geminiContent).not.toContain("● 76");
		expect(geminiContent).not.toContain("● 1");

		const gptOss = makeComponent(reports, { provider: "google-antigravity", modelId: "gpt-oss-120b" });
		gptOss.refreshUsageInBackground();
		await flushUsageRefresh();
		const gptOssContent = stripVTControlCharacters(gptOss.getTopBorder(200).content);
		expect(gptOssContent).toContain("google-antigravity ● 37");
		expect(gptOssContent).not.toContain("● 9");
		expect(gptOssContent).not.toContain("● 1");
		for (const modelId of ["tab_flash_lite_preview", "tab_jump_flash_lite_preview"]) {
			const tabModel = makeComponent(reports, { provider: "google-antigravity", modelId });
			tabModel.refreshUsageInBackground();
			await flushUsageRefresh();
			const tabContent = stripVTControlCharacters(tabModel.getTopBorder(200).content);
			expect(tabContent).toContain("google-antigravity ● 9");
			expect(tabContent).not.toContain("● 76");
			expect(tabContent).not.toContain("● 1");
		}
	});

	it("falls back to legacy default Antigravity usage when the model counter is absent", async () => {
		const component = makeComponent(
			[
				{
					provider: "google-antigravity",
					limits: [
						{
							id: "google-antigravity:default:default:daily",
							label: "Usage",
							scope: { provider: "google-antigravity", windowId: "daily" },
							window: { id: "daily", label: "Daily", durationMs: 86_400_000 },
							amount: { usedFraction: 0.42 },
						},
					],
				},
			],
			{ provider: "google-antigravity", modelId: "claude-opus-4-6" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(content).toContain("google-antigravity ● 58");
	});

	it("ignores non-canonical windows without a reported duration", async () => {
		const component = makeComponent([
			{
				provider: "anthropic",
				limits: [
					{ scope: { windowId: "burst" }, amount: { usedFraction: 0.24 } },
					{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("anthropic ● ?/92");
	});

	it("prefers canonical window IDs over conflicting durations", async () => {
		const component = makeComponent([
			{
				provider: "anthropic",
				limits: [
					{
						scope: { windowId: "5h" },
						window: { durationMs: 7 * 86_400_000 },
						amount: { usedFraction: 0.24 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();

		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("anthropic ● 76/?");
	});
});
