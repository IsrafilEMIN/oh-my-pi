import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const updater = path.join(repoRoot, "scripts", "omp-update");
const launcher = path.join(repoRoot, "scripts", "omp");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "omp-update-test",
	GIT_AUTHOR_EMAIL: "omp-update-test@example.com",
	GIT_COMMITTER_NAME: "omp-update-test",
	GIT_COMMITTER_EMAIL: "omp-update-test@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};

async function run(
	command: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = gitEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await run(["git", ...args], cwd);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

async function writeCheckoutFiles(root: string, marker: string): Promise<void> {
	await fs.mkdir(path.join(root, "packages/coding-agent/src"), { recursive: true });
	await Bun.write(
		path.join(root, "packages/coding-agent/package.json"),
		`${JSON.stringify({ name: "pi-coding-agent", version: "0.0.0", marker }, null, "\t")}\n`,
	);
	await Bun.write(path.join(root, "packages/coding-agent/src/cli.ts"), "export {};\n");
	await Bun.write(path.join(root, "README.md"), `${marker}\n`);
}

async function commitAll(cwd: string, message: string): Promise<string> {
	await git(cwd, ["add", "-A"]);
	await git(cwd, ["commit", "-m", message]);
	return git(cwd, ["rev-parse", "HEAD"]);
}

interface Fixture {
	home: string;
	checkout: string;
	upstreamBare: string;
	originBare: string;
}

async function createFixture(keepForkCommit = false): Promise<Fixture> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-"));
	tempDirs.push(home);
	const remotes = path.join(home, "remotes");
	const upstreamWork = path.join(home, "upstream-work");
	const originWork = path.join(home, "origin-work");
	const checkout = path.join(home, "checkout");
	const upstreamBare = path.join(remotes, "can1357", "oh-my-pi.git");
	const originBare = path.join(remotes, "IsrafilEMIN", "oh-my-pi.git");

	await fs.mkdir(upstreamWork, { recursive: true });
	await git(upstreamWork, ["init", "-b", "main"]);
	await writeCheckoutFiles(upstreamWork, "upstream-base");
	await commitAll(upstreamWork, "upstream base");
	await fs.mkdir(path.dirname(upstreamBare), { recursive: true });
	await git(home, ["clone", "--bare", upstreamWork, upstreamBare]);

	await git(home, ["clone", upstreamBare, originWork]);
	await writeCheckoutFiles(originWork, "fork-only");
	await Bun.write(path.join(originWork, "fork.txt"), "fork commit\n");
	await commitAll(originWork, "fork-only change");
	await fs.mkdir(path.dirname(originBare), { recursive: true });
	await git(home, ["clone", "--bare", originWork, originBare]);

	await git(home, ["clone", originBare, checkout]);
	await git(checkout, ["remote", "add", "upstream", upstreamBare]);
	await git(checkout, ["fetch", "upstream", "main"]);
	await git(checkout, ["checkout", "main"]);
	if (!keepForkCommit) {
		await git(checkout, ["reset", "--soft", "upstream/main"]);
		await git(checkout, ["reset"]);
	}

	return { home, checkout, upstreamBare, originBare };
}

async function advanceUpstream(fixture: Fixture, contents: string): Promise<void> {
	const work = path.join(fixture.home, `upstream-advance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await git(fixture.home, ["clone", fixture.upstreamBare, work]);
	await Bun.write(path.join(work, "upstream-new.txt"), contents);
	await commitAll(work, "upstream advance");
	await git(work, ["push", "origin", "main"]);
}

async function conflictUpstream(fixture: Fixture): Promise<void> {
	const work = path.join(fixture.home, `upstream-conflict-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await git(fixture.home, ["clone", fixture.upstreamBare, work]);
	await writeCheckoutFiles(work, "upstream-conflict");
	await commitAll(work, "upstream conflict");
	await git(work, ["push", "origin", "main"]);
}

function updateEnv(checkout: string): NodeJS.ProcessEnv {
	return { ...gitEnv, OMP_SOURCE_ROOT: checkout };
}

async function ompUpdate(
	checkout: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return run([updater, ...args], checkout, updateEnv(checkout));
}

async function resolveUnmergedWithTheirs(cwd: string): Promise<void> {
	const unmerged = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
	for (const file of unmerged) {
		await git(cwd, ["checkout", "--theirs", "--", file]);
	}
	await git(cwd, ["add", "-A"]);
}

describe("omp-update", () => {
	test("--help is dispatched through the checkout launcher", async () => {
		const result = await run([launcher, "update", "--help"], repoRoot);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage: omp-update [--check] [--no-build] [--no-push]");
	});

	test("--check reports current without moving HEAD or the delta", async () => {
		const fixture = await createFixture();
		const before = await git(fixture.checkout, ["rev-parse", "HEAD"]);
		const statusBefore = await git(fixture.checkout, ["status", "--porcelain"]);
		const originBefore = await git(fixture.checkout, ["rev-parse", "origin/main"]);
		const result = await ompUpdate(fixture.checkout, ["--check"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain(`head=${before}`);
		expect(result.stdout).toContain("behind=0");
		expect(result.stdout).toContain("ahead=0");
		expect(result.stdout).toContain("status=current");
		expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(before);
		expect(await git(fixture.checkout, ["status", "--porcelain"])).toBe(statusBefore);
		expect(await git(fixture.checkout, ["rev-parse", "origin/main"])).toBe(originBefore);
	});

	test("current update leaves the dirty delta untouched and mirrors origin", async () => {
		const fixture = await createFixture();
		const before = await git(fixture.checkout, ["rev-parse", "HEAD"]);
		const statusBefore = await git(fixture.checkout, ["status", "--porcelain"]);
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("omp-update: current");
		expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(before);
		expect(await git(fixture.checkout, ["status", "--porcelain"])).toBe(statusBefore);
		expect(await git(fixture.checkout, ["stash", "list"])).toBe("");
		expect(await git(fixture.checkout, ["rev-parse", "origin/main"])).toBe(before);
	});

	test("moves main to new upstream and re-applies the worktree delta", async () => {
		const fixture = await createFixture();
		await advanceUpstream(fixture, "new upstream file\n");
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("omp-update: updated (worktree delta re-applied)");
		expect(result.stdout).toContain("ahead=0");
		expect(await Bun.file(path.join(fixture.checkout, "upstream-new.txt")).text()).toBe("new upstream file\n");
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\n");
		expect(await git(fixture.checkout, ["rev-list", "--count", "upstream/main..HEAD"])).toBe("0");
		expect(await git(fixture.checkout, ["rev-parse", "origin/main"])).toBe(
			await git(fixture.checkout, ["rev-parse", "HEAD"]),
		);
		expect(await git(fixture.checkout, ["stash", "list"])).toBe("");
	});

	test("--no-push leaves origin untouched", async () => {
		const fixture = await createFixture();
		const originBefore = await git(fixture.checkout, ["rev-parse", "origin/main"]);
		await advanceUpstream(fixture, "new upstream file\n");
		const result = await ompUpdate(fixture.checkout, ["--no-build", "--no-push"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(await git(fixture.checkout, ["rev-parse", "origin/main"])).toBe(originBefore);
		expect(await git(fixture.checkout, ["rev-list", "--count", "upstream/main..HEAD"])).toBe("0");
	});

	test("rebases committed fork commits and preserves WIP", async () => {
		const fixture = await createFixture(true);
		await Bun.write(path.join(fixture.checkout, "wip.txt"), "wip change\n");
		expect(await git(fixture.checkout, ["rev-list", "--count", "upstream/main..HEAD"])).toBe("1");
		await advanceUpstream(fixture, "new upstream file\n");
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(await git(fixture.checkout, ["rev-list", "--count", "upstream/main..HEAD"])).toBe("1");
		expect(await Bun.file(path.join(fixture.checkout, "upstream-new.txt")).text()).toBe("new upstream file\n");
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\n");
		expect(await Bun.file(path.join(fixture.checkout, "wip.txt")).text()).toBe("wip change\n");
		expect(await git(fixture.checkout, ["status", "--porcelain"])).toContain("wip.txt");
		expect(await git(fixture.checkout, ["stash", "list"])).toBe("");
	});

	test("a second upstream update keeps ahead zero and preserves the delta", async () => {
		const fixture = await createFixture();
		await advanceUpstream(fixture, "first upstream file\n");
		const first = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
		await advanceUpstream(fixture, "second upstream file\n");
		const second = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(second.stdout).toContain("omp-update: updated (worktree delta re-applied)");
		expect(await Bun.file(path.join(fixture.checkout, "upstream-new.txt")).text()).toBe("second upstream file\n");
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\n");
		expect(await git(fixture.checkout, ["rev-list", "--count", "upstream/main..HEAD"])).toBe("0");
	});

	test("reports stash-pop conflicts and preserves the stash", async () => {
		const fixture = await createFixture();
		await conflictUpstream(fixture);
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("worktree delta conflicted on re-apply");
		expect(result.stderr).toContain("git stash drop");
		expect(result.stderr).not.toContain("git rebase upstream/main");
		expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(
			await git(fixture.checkout, ["rev-parse", "upstream/main"]),
		);
		expect(await git(fixture.checkout, ["status", "--porcelain"])).toContain("README.md");
		expect(await git(fixture.checkout, ["stash", "list"])).not.toBe("");
		const state = await Bun.file(path.join(fixture.checkout, ".git/omp-update/state")).text();
		expect(state).toContain("status=aborted-conflict");
		expect(state).toContain("stash_ref=");
	});

	test("pauses conflicting committed rebase while Git preserves WIP", async () => {
		const fixture = await createFixture(true);
		await Bun.write(path.join(fixture.checkout, "fork.txt"), "fork commit\ntracked WIP\n");
		await Bun.write(path.join(fixture.checkout, "wip.txt"), "untracked WIP\n");
		await conflictUpstream(fixture);
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("rebase paused with Git autostash active");
		expect(result.stderr).toContain("git rebase --continue");
		expect(result.stderr).not.toContain("git rebase upstream/main");
		expect(await Bun.file(path.join(fixture.checkout, ".git/rebase-merge/autostash")).exists()).toBe(true);
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\n");
		expect(await Bun.file(path.join(fixture.checkout, "wip.txt")).text()).toBe("untracked WIP\n");
		const state = await Bun.file(path.join(fixture.checkout, ".git/omp-update/state")).text();
		expect(state).toContain("status=rebase-conflict");
		await resolveUnmergedWithTheirs(fixture.checkout);
		const continued = await run(
			["git", "rebase", "--continue"],
			fixture.checkout,
			{ ...gitEnv, GIT_EDITOR: "true" },
		);
		expect(continued.exitCode, continued.stderr).toBe(0);
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\ntracked WIP\n");
		expect(await Bun.file(path.join(fixture.checkout, "wip.txt")).text()).toBe("untracked WIP\n");
		const finished = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(finished.exitCode, `${finished.stdout}\n${finished.stderr}`).toBe(0);
		expect(await git(fixture.checkout, ["rev-parse", "origin/main"])).toBe(
			await git(fixture.checkout, ["rev-parse", "HEAD"]),
		);
	});

	test("aborting a conflicting committed rebase restores tracked WIP", async () => {
		const fixture = await createFixture(true);
		const originalHead = await git(fixture.checkout, ["rev-parse", "HEAD"]);
		await Bun.write(path.join(fixture.checkout, "fork.txt"), "fork commit\ntracked WIP\n");
		await conflictUpstream(fixture);
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode).toBe(2);
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\n");
		await git(fixture.checkout, ["rebase", "--abort"]);
		expect(await git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(originalHead);
		expect(await Bun.file(path.join(fixture.checkout, "fork.txt")).text()).toBe("fork commit\ntracked WIP\n");
		expect(await git(fixture.checkout, ["branch", "--show-current"])).toBe("main");
		expect(await Bun.file(path.join(fixture.checkout, ".git/rebase-merge/autostash")).exists()).toBe(false);
	});

	test("suggests abort when a stale omp-update rebase is in progress", async () => {
		const fixture = await createFixture();
		const head = await git(fixture.checkout, ["rev-parse", "HEAD"]);
		await git(fixture.checkout, ["update-ref", "refs/omp-update/recovery", head]);
		await fs.mkdir(path.join(fixture.checkout, ".git/omp-update"), { recursive: true });
		await Bun.write(
			path.join(fixture.checkout, ".git/omp-update/state"),
			`status=started\nhead=${head}\n`,
		);
		await fs.mkdir(path.join(fixture.checkout, ".git/rebase-merge"), { recursive: true });
		const result = await ompUpdate(fixture.checkout, ["--no-build"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("left by omp-update");
		expect(result.stderr).toContain("git rebase --abort");
	});

	test("the checkout launcher honors OMP_SOURCE_ROOT for update --check", async () => {
		const fixture = await createFixture();
		const result = await run([launcher, "update", "--check"], repoRoot, updateEnv(fixture.checkout));
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain(`root=${fixture.checkout}`);
		expect(result.stdout).toContain("status=current");
	});
});
