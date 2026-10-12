import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositoryRoots, executionWorkspaceRepositoryAccess, executionWorkspaceRepositories, executionWorkspaces,
  heartbeatRuns, issueAccessGrants, issues, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertExecutionWorkspaceRootReadAccess, executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const acquisition = vi.hoisted(() => ({ managedAuth: vi.fn(), materialize: vi.fn(), catalog: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: acquisition.catalog }) }));
vi.mock("../services/git-credentials.js", async (original) => ({
  ...await original<typeof import("../services/git-credentials.js")>(),
  createGitRemoteAuthProvider: () => acquisition.managedAuth,
}));
vi.mock("../services/managed-repository-checkout.js", async (original) => ({
  ...await original<typeof import("../services/managed-repository-checkout.js")>(),
  materializeManagedProjectWorkspace: acquisition.materialize,
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task repository trust authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    database = await startEmbeddedPostgresTestDatabase("paperclip-repository-trust-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "paperclip-repository-trust-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
  afterAll(async () => { vi.unstubAllEnvs(); await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const userId = randomUUID(), cwd = path.join(root, issueId);
    await mkdir(cwd);
    await db.insert(companies).values({ id: companyId, name: "Repository trust", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat worker", adapterType: "process", status: "idle" });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Task files", cwd,
      mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Unlinked chat work", assigneeAgentId: agentId,
      executionWorkspaceId: workspace.id });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId,
      contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    acquisition.catalog.mockResolvedValue({ repositories: [{ id: "private-repo", fullName: "sponsor/private", private: true,
      url: "https://github.com/sponsor/private", connections: ["sponsor-github"] }] });
    acquisition.managedAuth.mockRejectedValue(new Error("Managed credentials must not be acquired"));
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId, onBehalfOfUserId: userId };
    const policy = { trustPreset: "low_trust_review" as const, authorizationPolicy: {
      trustPreset: "low_trust_review" as const, trustBoundary: { mode: "low_trust_review" as const, companyId, rootIssueId: issueId },
    } };
    const service = executionWorkspaceRepositoryService(db);
    const request = (repository: { kind: "catalog"; id: string } | { kind: "url"; url: string }, requestKey = randomUUID()) =>
      service.request({ companyId, issueId, actor, request: { repository, requestKey } });
    const admission = { companyId, issueId, workspaceId: workspace.id, cwd, agentId, runId, responsibleUserId: userId };
    return { companyId, agentId, issueId, runId, userId, workspace, policy, service, actor, request, admission };
  }

  async function lowTrustPeer(f: Awaited<ReturnType<typeof fixture>>, cwd = f.admission.cwd) {
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Low-trust alias",
      cwd, mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Low-trust peer",
      assigneeAgentId: f.agentId, executionWorkspaceId: workspace.id });
    const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
      trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, rootIssueId: issueId } } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
      responsibleUserId: f.userId, contextSnapshot: { issueId, executionPolicy: policy } });
    return { workspace, admission: { ...f.admission, cwd, issueId, runId, workspaceId: workspace.id }, actor: { ...f.actor, runId } };
  }

  async function standardPeer(f: Awaited<ReturnType<typeof fixture>>) {
    const userId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Other sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Other worker", adapterType: "process" });
    await db.insert(companyMemberships).values([
      { companyId: f.companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" },
      { companyId: f.companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Other task files", cwd: f.admission.cwd,
      mode: "shared_workspace", strategyType: "operator_directory" }).returning();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Other task", assigneeAgentId: agentId, executionWorkspaceId: workspace.id });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, responsibleUserId: userId, status: "running", contextSnapshot: { issueId } });
    return { userId, agentId, issueId, runId, workspace,
      actor: { ...f.actor, agentId, runId, onBehalfOfUserId: userId },
      admission: { ...f.admission, agentId, runId, issueId, workspaceId: workspace.id, responsibleUserId: userId } };
  }
  async function privateTask(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: f.issueId, responsibleUserId: f.userId }).where(eq(issues.id, f.issueId));
  }
  async function grantPeer(f: Awaited<ReturnType<typeof fixture>>, peer: Awaited<ReturnType<typeof standardPeer>>) {
    return db.insert(issueAccessGrants).values([
      { issueId: f.issueId, subjectType: "agent", subjectId: peer.agentId, source: "explicit", grantedByUserId: f.userId },
      { issueId: f.issueId, subjectType: "user", subjectId: peer.userId, source: "explicit", grantedByUserId: f.userId },
    ]).returning();
  }
  async function localPrivateClone(f: Awaited<ReturnType<typeof fixture>>, beforePublish?: () => Promise<void>) {
    const source = path.join(root, `${f.issueId}-privacy-source`);
    await mkdir(source);
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "private.txt"), "Private task edits\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce((cwd, input) => actual.materializeManagedProjectWorkspace(cwd, { ...input, localSource: source,
      beforePublish: async cloneCwd => { await beforePublish?.(); await input.beforePublish(cloneCwd); } }));
  }

  it.each(["empty", "different_identity", "unreadable_alias", "anonymous_private_edits", "authorized_peer"] as const)(
    "authorizes every physical repository source for a standard reader with %s", async scenario => {
      const f = await fixture(), peer = await standardPeer(f);
      if (scenario === "different_identity") await f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
        request: { repository: { kind: "url", url: "https://github.com/public/other" }, requestKey: randomUUID() } });
      await privateTask(f);
      const intent = await f.request(scenario === "anonymous_private_edits" ? { kind: "url", url: "https://github.com/public/source" } : { kind: "catalog", id: "private-repo" });
      await localPrivateClone(f);
      const [prepared] = await f.service.prepareForAdmission(f.admission);
      expect(await readFile(path.join(prepared.cwd, "private.txt"), "utf8")).toBe("Private task edits\n");
      if (scenario === "unreadable_alias") {
        const alias = path.join(root, `${f.issueId}-private-alias`);
        await symlink(f.admission.cwd, alias);
        await db.update(executionWorkspaces).set({ cwd: alias }).where(eq(executionWorkspaces.id, f.workspace.id));
        // Published path evidence must also bootstrap provenance for old rows.
        await db.delete(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
        const actual = fs.realpath.bind(fs);
        vi.spyOn(fs, "realpath").mockImplementation(async pathname => {
          if (String(pathname) === alias) throw Object.assign(new Error("Private alias unavailable"), { code: "EACCES" });
          return actual(pathname);
        });
      }
      if (scenario === "authorized_peer") {
        await grantPeer(f, peer);
        await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
      } else await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/workspace access|authorization boundary/);
      expect((await f.service.list(f.companyId, f.workspace.id))[0].id).toBe(intent.operationId);
      expect(acquisition.materialize).toHaveBeenCalledOnce();
    },
  );

  it.each(["retained", "legacy"] as const)("keeps independent copies of the same repository separate (%s provenance)", async provenance => {
    const f = await fixture(), peer = await standardPeer(f);
    const peerCwd = path.join(root, peer.issueId);
    await mkdir(peerCwd);
    await db.update(executionWorkspaces).set({ cwd: peerCwd }).where(eq(executionWorkspaces.id, peer.workspace.id));
    peer.admission.cwd = peerCwd;
    await privateTask(f);
    const repository = { kind: "url" as const, url: "https://github.com/public/source" };
    await f.request(repository);
    await localPrivateClone(f);
    const [privateCheckout] = await f.service.prepareForAdmission(f.admission);
    await f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository, requestKey: randomUUID() } });
    await localPrivateClone({ ...f, issueId: peer.issueId });
    const [peerCheckout] = await f.service.prepareForAdmission(peer.admission);
    expect(peerCheckout.cwd).not.toBe(privateCheckout.cwd);
    expect(await readFile(path.join(peerCheckout.cwd, "private.txt"), "utf8")).toBe("Private task edits\n");
    if (provenance === "legacy") await db.delete(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(actual.materializeManagedProjectWorkspace);
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toHaveLength(1);
    const beforeRead = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: peerCwd,
      sourceWorkspaceId: peer.workspace.id, actor: peer.actor })).resolves.toBeUndefined();
    await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: f.admission.cwd,
      sourceWorkspaceId: f.workspace.id, actor: peer.actor })).rejects.toThrow(/workspace access|authorization boundary/);
    expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId))).toEqual(beforeRead);
  });

  it("rechecks retained own-workspace privacy without adding an empty-admission membership gate", async () => {
    const f = await fixture();
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(executionWorkspaceRepositoryService(db).prepareForAdmission(f.admission)).resolves.toEqual([]);
    const [privateSource] = await db.insert(issues).values({ companyId: f.companyId, title: "Other private writer", visibility: "private",
      executionWorkspaceId: f.workspace.id }).returning();
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, privateSource.id));
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/workspace access/);
  });

  it("does not publish managed bytes to a retained low-trust reader even with private source grants", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: peer.issueId, responsibleUserId: peer.userId,
      parentId: f.issueId }).where(eq(issues.id, peer.issueId));
    await db.insert(issueAccessGrants).values([
      { issueId: peer.issueId, subjectType: "agent", subjectId: f.agentId, source: "explicit", grantedByUserId: peer.userId },
      { issueId: peer.issueId, subjectType: "user", subjectId: f.userId, source: "explicit", grantedByUserId: peer.userId },
    ]);
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } })).rejects.toThrow(/anonymous public URLs only/);
    expect(await f.service.list(f.companyId, peer.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("retains private direct files from an admitted workspace with no repository inventory", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await privateTask(f);
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await writeFile(path.join(f.admission.cwd, "private-direct.txt"), "Private direct task output");
    await db.update(executionWorkspaces).set({ cwd: path.join(root, "moved-direct-source"), metadata: {} }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/workspace access|authorization boundary/);
    await grantPeer(f, peer);
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    expect(await readFile(path.join(f.admission.cwd, "private-direct.txt"), "utf8")).toBe("Private direct task output");
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("blocks a future private source after an empty standard reader was admitted and moved", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    await db.update(executionWorkspaces).set({ cwd: path.join(root, "moved-standard-reader"), metadata: {}, status: "archived" }).where(eq(executionWorkspaces.id, peer.workspace.id));
    await privateTask(f);
    await expect(executionWorkspaceRepositoryService(db).request({ companyId: f.companyId, issueId: f.issueId, actor: f.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } })).rejects.toThrow(/workspace access|authorization boundary/);
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("rechecks configured-source publication against retained readers after grant revocation", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await privateTask(f);
    const grants = await grantPeer(f, peer);
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    await expect(f.service.guardForPublication(f.admission)).resolves.toBeUndefined();
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grants[0].id));
    await expect(f.service.guardForPublication(f.admission)).rejects.toThrow(/workspace access|authorization boundary/);
    await expect(f.service.guardForPublication({ ...f.admission, workspaceId: peer.workspace.id })).rejects.toThrow(/publication binding/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.catalog).not.toHaveBeenCalled();
  });

  it("fences pending private clones and rechecks granted readers before actual publication", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await privateTask(f);
    const intent = await f.request({ kind: "catalog", id: "private-repo" });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const staged = new Promise<void>(resolve => { started = resolve; });
    await localPrivateClone(f, async () => { started(); await gate; });
    const preparation = f.service.prepareForAdmission(f.admission);
    const outcome = preparation.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await Promise.race([staged, outcome.then(() => { throw new Error("Clone ended before publication barrier"); })]);
      await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/workspace access|authorization boundary/);
      await grantPeer(f, peer);
      await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
      await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.issueId, f.issueId));
    } finally { release(); }
    expect((await outcome).error).toBeTruthy();
    expect(await fs.lstat(path.join(f.admission.cwd, intent.repository.relativePath)).catch(() => null)).toBeNull();
  });

  it.each(["agent", "issue", "project", "workspace_source_project", "run"] as const)(
    "rejects catalog acquisition from raw %s low-trust policy", async source => {
      const f = await fixture();
      if (source === "agent") await db.update(agents).set({ permissions: f.policy }).where(eq(agents.id, f.agentId));
      if (source === "issue") await db.update(issues).set({ executionPolicy: f.policy }).where(eq(issues.id, f.issueId));
      if (source === "run") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
      if (source === "project" || source === "workspace_source_project") {
        const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Restricted", executionWorkspacePolicy: f.policy }).returning();
        if (source === "project") await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
        else {
          await db.update(projects).set({ executionWorkspacePolicy: { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
            trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [project.id] } } } }).where(eq(projects.id, project.id));
          await db.update(executionWorkspaces).set({ projectId: project.id, strategyType: "git_worktree" }).where(eq(executionWorkspaces.id, f.workspace.id));
        }
      }
      await expect(f.request({ kind: "catalog", id: "private-repo" })).rejects.toThrow(/anonymous public URLs only/);
      expect(await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.companyId, f.companyId))).toHaveLength(0);
      expect(acquisition.managedAuth).not.toHaveBeenCalled();
    },
  );

  it("keeps a URL matching the sponsor's private catalog anonymous under retained run trust", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    const receipt = await f.request({ kind: "url", url: "https://github.com/sponsor/private" });
    expect(receipt.repository.catalogRepositoryId).toBeNull();
    acquisition.materialize.mockImplementationOnce(async (_cwd, input) => {
      const auth = await input.resolveGitAuth(input.repoUrl);
      expect(auth).toEqual({ ...buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null }),
        env: expect.objectContaining({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }) });
      throw new Error("Anonymous remote rejects private repository");
    });
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow("Anonymous remote rejects private repository");
    expect(acquisition.materialize).toHaveBeenCalledOnce();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    const [stored] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    expect(stored).toMatchObject({ catalogRepositoryId: null, state: "needs_repair" });
  });

  it.each(["pending", "ready"] as const)("blocks a %s managed receipt after the run becomes low trust", async state => {
    const f = await fixture();
    const receipt = await f.request({ kind: "catalog", id: "private-repo" });
    await db.update(executionWorkspaceRepositories).set({ state, pinnedCommit: state === "ready" ? "a".repeat(40) : null })
      .where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    const checkout = path.join(f.admission.cwd, receipt.repository.relativePath);
    if (state === "ready") { await mkdir(checkout, { recursive: true }); await writeFile(path.join(checkout, "private.txt"), "retained private bytes"); }
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.request({ kind: "url", url: receipt.repository.repoUrl })).rejects.toThrow(/anonymous public URLs only/);
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/anonymous public URLs only/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    if (state === "ready") expect(await readFile(path.join(checkout, "private.txt"), "utf8")).toBe("retained private bytes");
  });

  it("prepares an anonymous public URL through actual local Git materialization", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    const receipt = await f.request({ kind: "url", url: "https://github.com/public/example" });
    const source = path.join(root, `${f.issueId}-public-source`);
    await mkdir(source);
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "public.txt"), "Public fixture bytes\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "public source"]);
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(async (cwd, input) => {
      const auth = await input.resolveGitAuth(input.repoUrl);
      expect(auth.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
      expect(auth.configArgs).toEqual(buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null }).configArgs);
      const result = await actual.materializeManagedProjectWorkspace(cwd, { ...input, localSource: source });
      await exec("git", ["-C", cwd, "remote", "set-url", "origin", input.repoUrl]);
      return result;
    });
    const [prepared] = await f.service.prepareForAdmission(f.admission);
    expect(prepared.id).toBe(receipt.operationId);
    expect(await readFile(path.join(prepared.cwd, "public.txt"), "utf8")).toBe("Public fixture bytes\n");
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it.each(["same_repository", "different_repository", "empty_inventory", "unpinned_publication", "pending_intent"] as const)(
    "rejects managed peer bytes in the same physical root with %s", async scenario => {
      const f = await fixture();
      const managed = await f.request({ kind: "catalog", id: "private-repo" });
      const checkout = path.join(f.admission.cwd, managed.repository.relativePath);
      if (scenario !== "pending_intent") {
        await mkdir(path.join(checkout, ".git"), { recursive: true });
        await writeFile(path.join(checkout, "private.txt"), "Private peer bytes");
      } else {
        // A legacy pending intent has neither a root-policy row nor published bytes.
        await db.delete(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
      }
      if (scenario !== "unpinned_publication" && scenario !== "pending_intent") await db.update(executionWorkspaceRepositories)
        .set({ state: "ready", pinnedCommit: "b".repeat(40) }).where(eq(executionWorkspaceRepositories.id, managed.operationId));
      const [peer] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Same physical folder",
        cwd: f.admission.cwd, mode: "isolated_workspace", strategyType: "task_directory" }).returning();
      const issueId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Low-trust peer", assigneeAgentId: f.agentId,
        executionWorkspaceId: peer.id });
      const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
        trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, rootIssueId: issueId } } };
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
        responsibleUserId: f.userId, contextSnapshot: { issueId, executionPolicy: policy } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      if (scenario !== "empty_inventory") await expect(f.service.request({ companyId: f.companyId, issueId, actor: { ...f.actor, runId },
        request: { requestKey: randomUUID(), repository: { kind: "url", url: scenario === "same_repository" ? managed.repository.repoUrl : "https://github.com/public/other" } } }))
        .rejects.toThrow(/anonymous public URLs only/);
      await expect(f.service.prepareForAdmission({ ...f.admission, issueId, runId, workspaceId: peer.id })).rejects.toThrow(/anonymous public URLs only/);
      expect(acquisition.materialize).not.toHaveBeenCalled();
      expect(acquisition.managedAuth).not.toHaveBeenCalled();
      if (scenario !== "pending_intent") expect(await readFile(path.join(checkout, "private.txt"), "utf8")).toBe("Private peer bytes");
    },
  );

  it.each([
    { marker: "valid", reserved: false }, { marker: "malformed", reserved: false }, { marker: "symlink", reserved: false },
    { marker: "valid", reserved: true }, { marker: "malformed", reserved: true }, { marker: "symlink", reserved: true },
  ])("rejects readable private publication behind an unreadable alias ($marker marker, reserved=$reserved)", async ({ marker, reserved }) => {
    const f = await fixture();
    const receipt = await f.request({ kind: "catalog", id: "private-repo" });
    // Emulate a pre-fence managed publication and, optionally, a reservation
    // created by the older unreadable-alias bug.
    await db.delete(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    const checkout = path.join(f.admission.cwd, receipt.repository.relativePath);
    await mkdir(checkout, { recursive: true });
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", checkout]);
    await writeFile(path.join(checkout, "private.txt"), "Private published bytes must never enter low-trust capture\n");
    await exec("git", ["-C", checkout, "add", "."]);
    await exec("git", ["-C", checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "private source"]);
    const pin = (await exec("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
    const owner = path.join(checkout, ".git", "paperclip-workspace-owner.json");
    const ownerJson = JSON.stringify({ version: 1, repositoryId: receipt.operationId, pinnedCommit: pin });
    if (marker === "symlink") {
      const target = path.join(root, `${f.issueId}-untrusted-owner`);
      await writeFile(target, ownerJson);
      await symlink(target, owner);
    } else await writeFile(owner, marker === "valid" ? ownerJson : "{unverifiable owner");
    await db.update(executionWorkspaceRepositories).set({ state: "ready", pinnedCommit: pin }).where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    const aliasParent = path.join(root, `${f.issueId}-unreadable`);
    await mkdir(aliasParent);
    const alias = path.join(aliasParent, "workspace");
    await symlink(f.admission.cwd, alias);
    await db.update(executionWorkspaces).set({ cwd: alias }).where(eq(executionWorkspaces.id, f.workspace.id));
    const peer = await lowTrustPeer(f);
    const canonicalCwd = await realpath(f.admission.cwd);
    if (reserved) await db.insert(executionWorkspaceRepositoryRoots).values({ companyId: f.companyId, canonicalCwd,
      rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), mode: "anonymous_only" });
    const actual = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async pathname => {
      if (String(pathname).startsWith(aliasParent)) throw Object.assign(new Error("Unreadable legacy alias"), { code: "EACCES" });
      return actual(pathname);
    });
    await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/anonymous public URLs only/);
    await expect(f.service.request({ companyId: f.companyId, issueId: peer.admission.issueId, actor: peer.actor,
      request: { repository: { kind: "url", url: "https://github.com/public/unrelated" }, requestKey: randomUUID() } }))
      .rejects.toThrow(/anonymous public URLs only/);
    expect(await f.service.list(f.companyId, peer.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    expect(await readFile(path.join(checkout, "private.txt"), "utf8")).toContain("Private published bytes");
  });

  it.each(["standard", "retained_low_trust", "current_low_trust"] as const)("recovers an exact legacy run-ID binding with %s trust", async trust => {
    const f = await fixture();
    const execution = buildNativeExecutionInput({
      companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      issue: { id: f.issueId, identifier: "LEG-1", title: "Legacy recovery", description: null, workMode: "standard" },
      taskPrompt: "Continue", normalizedSessionId: randomUUID(), provider: "codex",
      workspace: { id: f.runId, cwd: f.admission.cwd, repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Recover", criteria: [{ id: "objective", requirement: "Keep the admitted folder" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: execution },
      contextSnapshot: { issueId: f.issueId, ...(trust === "retained_low_trust" ? { executionPolicy: f.policy } : {}) } }).where(eq(heartbeatRuns.id, f.runId));
    if (trust === "current_low_trust") await db.update(agents).set({ permissions: f.policy }).where(eq(agents.id, f.agentId));
    await expect(f.service.reserveForRecovery({ ...f.admission, workspaceId: f.runId })).resolves.toBeUndefined();
    const reservations = await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    expect(reservations).toHaveLength(trust === "standard" ? 0 : 1);
    if (trust !== "standard") expect(reservations[0].mode).toBe("anonymous_only");
    await expect(f.service.reserveForRecovery({ ...f.admission, workspaceId: randomUUID() })).rejects.toThrow(/recovery identity/);
    execution.binding.agentId = randomUUID();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.reserveForRecovery({ ...f.admission, workspaceId: f.runId })).rejects.toThrow(/recovery identity/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each(["ENOTDIR", "EACCES"] as const)("ignores unrelated unavailable legacy managed paths (%s) while preserving anonymous roots", async code => {
    const f = await fixture();
    await f.request({ kind: "catalog", id: "private-repo" });
    await db.delete(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    const peerRoot = path.join(root, `${f.issueId}-anonymous`);
    await mkdir(peerRoot);
    const peer = await lowTrustPeer(f, peerRoot);
    const unavailableParent = path.join(root, `${f.issueId}-unavailable`);
    await writeFile(unavailableParent, "Archived directory replaced by a file");
    const unavailableCwd = path.join(unavailableParent, "checkout");
    await db.update(executionWorkspaces).set({ cwd: unavailableCwd, status: "archived" }).where(eq(executionWorkspaces.id, f.workspace.id));
    if (code === "EACCES") {
      const actual = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async pathname => {
        if (String(pathname).startsWith(unavailableParent)) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
        return actual(pathname);
      });
    }
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    // Once fenced, unrelated historical paths need no further filesystem reads.
    vi.restoreAllMocks();
    const actual = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async pathname => {
      if (String(pathname) === unavailableCwd) throw new Error("Historical path must not be revisited");
      return actual(pathname);
    });
    await expect(executionWorkspaceRepositoryService(db).prepareForAdmission(peer.admission)).resolves.toEqual([]);
  });

  it("still rejects a legacy pending managed receipt through a canonical path alias", async () => {
    const f = await fixture();
    await f.request({ kind: "catalog", id: "private-repo" });
    await db.delete(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    const alias = path.join(root, `${f.issueId}-legacy-alias`);
    await symlink(f.admission.cwd, alias);
    await db.update(executionWorkspaces).set({ cwd: alias }).where(eq(executionWorkspaces.id, f.workspace.id));
    const peer = await lowTrustPeer(f);
    await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/anonymous public URLs only/);
  });

  it("reserves a legacy low-trust recovery folder after its task binding moves", async () => {
    const f = await fixture();
    const peer = await lowTrustPeer(f);
    await db.update(issues).set({ parentId: peer.admission.issueId }).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, peer.admission.issueId));
    await db.update(executionWorkspaces).set({ cwd: path.join(root, "moved-recovery"), metadata: {}, status: "archived" })
      .where(eq(executionWorkspaces.id, peer.workspace.id));
    await f.service.reserveForRecovery(peer.admission);
    await expect(executionWorkspaceRepositoryService(db).request({ companyId: f.companyId, issueId: f.issueId, actor: f.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } }))
      .rejects.toThrow(/anonymous public URLs only/);
    const [reservation] = await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    expect(reservation).toMatchObject({ canonicalCwd: await realpath(f.admission.cwd), mode: "anonymous_only" });
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it("reserves a legacy managed recovery folder before a low-trust peer resumes", async () => {
    const f = await fixture();
    await f.request({ kind: "catalog", id: "private-repo" });
    await db.delete(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    const peer = await lowTrustPeer(f);
    await f.service.reserveForRecovery(f.admission);
    await db.update(executionWorkspaces).set({ cwd: path.join(root, "moved-managed-recovery") }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(executionWorkspaceRepositoryService(db).reserveForRecovery(peer.admission)).rejects.toThrow(/anonymous public URLs only/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("serializes a managed request against anonymous admission through physical aliases", async () => {
    const f = await fixture();
    const alias = path.join(root, `${f.issueId}-alias`);
    await symlink(f.admission.cwd, alias);
    const peer = await lowTrustPeer(f, alias);
    await db.update(issues).set({ parentId: peer.admission.issueId }).where(eq(issues.id, f.issueId));
    const outcomes = await Promise.allSettled([
      f.service.prepareForAdmission(peer.admission),
      f.request({ kind: "catalog", id: "private-repo" }),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const [reservation] = await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    expect(reservation.mode).toBe(outcomes[0].status === "fulfilled" ? "anonymous_only" : "managed");
    const restarted = executionWorkspaceRepositoryService(db);
    if (reservation.mode === "anonymous_only") {
      await expect(f.request({ kind: "catalog", id: "private-repo" })).rejects.toThrow(/anonymous public URLs only/);
      await expect(restarted.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    } else await expect(restarted.prepareForAdmission(peer.admission)).rejects.toThrow(/anonymous public URLs only/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("keeps anonymous root ownership across workspace moves and blocks future catalog promotion", async () => {
    const f = await fixture();
    // A standard task's initially anonymous intent may later appear in its catalog.
    const pending = await f.request({ kind: "url", url: "https://github.com/public/later-catalog" });
    const peer = await lowTrustPeer(f);
    // This source task belongs to the reader's trusted task subtree.
    await db.update(issues).set({ parentId: peer.admission.issueId }).where(eq(issues.id, f.issueId));
    await f.service.prepareForAdmission(peer.admission);
    await db.update(executionWorkspaces).set({ cwd: path.join(root, "moved-anonymous-workspace"), metadata: {}, status: "archived" })
      .where(eq(executionWorkspaces.id, peer.workspace.id));
    const restarted = executionWorkspaceRepositoryService(db);
    await expect(restarted.request({ companyId: f.companyId, issueId: f.issueId, actor: f.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } })).rejects.toThrow(/anonymous public URLs only/);
    acquisition.catalog.mockResolvedValue({ repositories: [{ id: "later", fullName: "public/later-catalog", private: true,
      url: pending.repository.repoUrl, connections: ["sponsor-github"] }] });
    await expect(restarted.prepareForAdmission(f.admission)).rejects.toThrow(/anonymous public URLs only/);
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect((await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, pending.operationId)))[0].catalogRepositoryId).toBeNull();
  });

  it("rejects anonymous admission while a managed clone is waiting to publish", async () => {
    const f = await fixture();
    const receipt = await f.request({ kind: "catalog", id: "private-repo" });
    const peer = await lowTrustPeer(f);
    const source = path.join(root, `${f.issueId}-private-source`);
    await mkdir(source);
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "private.txt"), "Private fixture bytes\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "private source"]);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const staged = new Promise<void>(resolve => { started = resolve; });
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(async (cwd, input) => {
      const result = await actual.materializeManagedProjectWorkspace(cwd, { ...input, localSource: source,
        beforePublish: async cloneCwd => {
          await input.beforePublish(cloneCwd);
          started();
          await gate;
        } });
      await exec("git", ["-C", cwd, "remote", "set-url", "origin", input.repoUrl]);
      return result;
    });
    const preparation = f.service.prepareForAdmission(f.admission);
    try {
      await Promise.race([staged, preparation.then(() => { throw new Error("Managed preparation finished before publication barrier"); })]);
      const [pending] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, receipt.operationId));
      expect(pending).toMatchObject({ state: "preparing", pinnedCommit: null });
      // The reservation remains anchored to the physical root even if ordinary
      // metadata/placement maintenance changes the originating workspace row.
      await db.update(executionWorkspaces).set({ cwd: path.join(root, "moved-managed-workspace"), metadata: {} }).where(eq(executionWorkspaces.id, f.workspace.id));
      await expect(executionWorkspaceRepositoryService(db).prepareForAdmission(peer.admission)).rejects.toThrow(/anonymous public URLs only/);
    } finally { release(); }
    const [prepared] = await preparation;
    expect(await readFile(path.join(prepared.cwd, "private.txt"), "utf8")).toBe("Private fixture bytes\n");
    await expect(executionWorkspaceRepositoryService(db).prepareForAdmission(peer.admission)).rejects.toThrow(/anonymous public URLs only/);
  });

  it("retains previous run trust without confusing a board request's reassigned agent", async () => {
    const f = await fixture();
    const [replacement] = await db.insert(agents).values({ companyId: f.companyId, name: "Replacement", adapterType: "process" }).returning();
    await db.update(issues).set({ assigneeAgentId: replacement.id }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", contextSnapshot: { taskId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    const request = () => f.service.request({ companyId: f.companyId, issueId: f.issueId,
      actor: { type: "board", source: "local_implicit", userId: "local-board" },
      request: { requestKey: randomUUID(), repository: { kind: "catalog", id: "private-repo" } } });
    await expect(request()).resolves.toMatchObject({ kind: "requires_next_admission" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(request()).rejects.toThrow(/anonymous public URLs only/);
  });

  it("preserves standard empty-inventory admission without repository mutation authority", async () => {
    const f = await fixture();
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    expect(acquisition.catalog).not.toHaveBeenCalled();
    expect(acquisition.materialize).not.toHaveBeenCalled();
    // Adding an acquisition still requires the full authorization intersection.
    await db.insert(executionWorkspaceRepositories).values({ companyId: f.companyId, executionWorkspaceId: f.workspace.id,
      requestedByIssueId: f.issueId, repositoryIdentity: "https://github.com/public/example", repoUrl: "https://github.com/public/example",
      relativePath: ".paperclip-repositories/unused", requestedRef: "HEAD", requestKey: "requires-authority", requestKeys: ["requires-authority"] });
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow();
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("keeps low-trust empty-inventory admission free of acquisition-only filesystem and membership requirements", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    await expect(f.service.prepareForAdmission({ ...f.admission, cwd: path.join(root, "not-materialized") })).resolves.toEqual([]);
    expect(acquisition.catalog).not.toHaveBeenCalled();
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("rejects admission without the persisted task run before materialization", async () => {
    const f = await fixture();
    await f.request({ kind: "catalog", id: "private-repo" });
    await expect(f.service.prepareForAdmission({ ...f.admission, runId: randomUUID() })).rejects.toThrow(/run identity/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });
});
