import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, projects, projectWorkspaces, executionWorkspaceRepositoryAccess, executionWorkspaceRepositoryRoots, executionWorkspaceRepositories, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { prepareWorkspaceRepositorySchema, type PrepareWorkspaceRepository, type ProjectRepository } from "@paperclipai/shared";
import { withDirectoryPublicationLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { conflict, forbidden, notFound } from "../errors.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { assertTaskWorkspaceAccess, assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-source-access.js";
import { authorizationService, canActorReadExecutionWorkspace, executionWorkspaceReadSqlCondition, issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { captureRunIdentity } from "./run-identity.js";
import { toolAccessService } from "./tool-access.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { buildGitAuthInvocation, createGitRemoteAuthProvider } from "./git-credentials.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "./managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
type RepositoryRow = typeof executionWorkspaceRepositories.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Match physical aliases, including task directories not materialized yet. */
async function canonicalRepositoryRoot(cwd: string): Promise<string> {
  const absolute = path.resolve(cwd);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalRepositoryRoot(parent), path.basename(absolute));
  }
}

/** An unavailable legacy path must not block unrelated roots. Preserve the
 * unresolved suffix and reject roots inside an inaccessible prefix, since a
 * hidden symlink may still point at the candidate's admitted directory. */
async function legacyRepositoryRootMayMatch(cwd: string, candidate: string): Promise<boolean> {
  const absolute = path.resolve(cwd);
  if (absolute === candidate) return true;
  let probe = absolute;
  let suffix = "";
  let inaccessiblePrefix: string | null = null;
  for (;;) {
    try {
      const canonical = await fs.realpath(probe);
      if (path.join(canonical, suffix) === candidate) return true;
      if (!inaccessiblePrefix) return false;
      const unresolved = path.join(canonical, path.relative(probe, inaccessiblePrefix));
      return candidate === unresolved || candidate.startsWith(`${unresolved}${path.sep}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) throw error;
      if (code === "EACCES" || code === "EPERM") inaccessiblePrefix = probe;
      const parent = path.dirname(probe);
      if (parent === probe) return true;
      suffix = path.join(path.basename(probe), suffix);
      probe = parent;
    }
  }
}

const lowTrustRepositoryMessage = "Low-trust tasks may prepare anonymous public URLs only. Use an authorized configured source for private repositories.";

function resolveAcquisitionSource(request: PrepareWorkspaceRepository["repository"], available: ProjectRepository[], anonymousOnly: boolean) {
  if (anonymousOnly && request.kind === "catalog") throw forbidden(lowTrustRepositoryMessage);
  // A sponsor's catalog is credential discovery, not authority for untrusted work.
  return resolveTaskRepository(request, anonymousOnly ? [] : available);
}

function assertAcquisitionReceipt(row: Pick<RepositoryRow, "catalogRepositoryId">, anonymousOnly: boolean) {
  if (anonymousOnly && row.catalogRepositoryId) throw forbidden(lowTrustRepositoryMessage);
}

/** The catalog is refreshed on request and admission; saved IDs are not grants. */
export function resolveTaskRepository(request: PrepareWorkspaceRepository["repository"], available: ProjectRepository[]) {
  const selected = request.kind === "catalog" ? available.find(repo => repo.id === request.id) : null;
  if (request.kind === "catalog" && !selected) throw forbidden("Repository access is no longer available; refresh the repository catalog");
  const source = normalizeProjectRepositoryUrl(selected?.url ?? (request.kind === "url" ? request.url : ""));
  const match = selected ?? available.find(repo => normalizeProjectRepositoryUrl(repo.url).url.toLowerCase() === source.url.toLowerCase());
  return { repoUrl: source.url, repositoryIdentity: source.url.toLowerCase(), catalogRepositoryId: match?.id ?? null };
}

export function taskRepositoryRelativePath(identity: string) {
  return `.paperclip-repositories/task-repo-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function assertRepositoryRetryMatches(row: Pick<RepositoryRow, "repositoryIdentity" | "requestedRef">, identity: string, ref: string) {
  if (row.repositoryIdentity !== identity || row.requestedRef !== ref) {
    throw conflict("Repository preparation conflicts with an existing receipt. A different ref requires a separate workspace; existing files are never switched automatically.");
  }
}

/** Resolve persisted and physical file provenance without registering readers or policies. */
async function resolveRepositoryRootSources(tx: Db | DbTransaction, input: {
  companyId: string; cwd: string; sourceWorkspaceId?: string; inspectCurrentAliases?: boolean;
}) {
  const canonicalCwd = await canonicalRepositoryRoot(input.cwd);
  const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
  const entries = await tx.select().from(executionWorkspaceRepositoryAccess).where(and(
    eq(executionWorkspaceRepositoryAccess.companyId, input.companyId), eq(executionWorkspaceRepositoryAccess.rootKey, rootKey)));
  if (entries.some(entry => entry.canonicalCwd !== canonicalCwd)) throw forbidden("Repository root identity conflicts with its retained access record");
  const sourceIds = new Set(entries.filter(entry => entry.kind === "source").map(entry => entry.scopeId));
  if (input.sourceWorkspaceId) sourceIds.add(input.sourceWorkspaceId);
  const inspectCurrentAliases = input.inspectCurrentAliases || !entries.some(entry => entry.kind === "reader");
  if (inspectCurrentAliases) {
    // Include current physical aliases as well as sticky historical sources.
    // Ordinary task files carry privacy even without acquisition receipts.
    const workspaces = await tx.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd }).from(executionWorkspaces)
      .where(eq(executionWorkspaces.companyId, input.companyId));
    for (const workspace of workspaces) {
      if (!workspace.cwd) continue;
      const peerRoot = await canonicalRepositoryRoot(workspace.cwd).catch((error: NodeJS.ErrnoException) => {
        if (["ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return null;
        throw error;
      });
      if (peerRoot === canonicalCwd) sourceIds.add(workspace.id);
    }
  }
  const inventory = await tx.select({ id: executionWorkspaceRepositories.id, workspaceId: executionWorkspaces.id, cwd: executionWorkspaces.cwd,
    identity: executionWorkspaceRepositories.repositoryIdentity }).from(executionWorkspaceRepositories)
    .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
    .where(and(eq(executionWorkspaceRepositories.companyId, input.companyId), eq(executionWorkspaces.companyId, input.companyId)));
  const namespace = path.join(canonicalCwd, ".paperclip-repositories");
  const namespaceEntry = await fs.lstat(namespace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const publishedNames = new Set<string>();
  if (namespaceEntry) {
    if (!namespaceEntry.isDirectory() || namespaceEntry.isSymbolicLink() || await fs.realpath(namespace) !== namespace) {
      throw forbidden("Repository namespace has no verifiable contained ownership");
    }
    // Configured project siblings have a separate source owner. This child
    // aggregate owns only task-repo-* publications and their retained provenance.
    for (const name of await fs.readdir(namespace)) if (name.startsWith("task-repo-")) publishedNames.add(name);
  }
  // Birth records distinguish new, fenced acquisitions from legacy receipts.
  // Never infer origin for an old receipt merely because it is encountered now.
  const repositoryOrigins = await tx.select({ id: executionWorkspaceRepositoryAccess.scopeId }).from(executionWorkspaceRepositoryAccess)
    .where(and(eq(executionWorkspaceRepositoryAccess.companyId, input.companyId), eq(executionWorkspaceRepositoryAccess.kind, "repository")));
  const knownOrigins = new Set(repositoryOrigins.map(origin => origin.id));
  const recognizedNames = new Set<string>();
  for (const peer of inventory) {
    const name = path.basename(taskRepositoryRelativePath(peer.identity));
    const published = publishedNames.has(name);
    if (!published && !inspectCurrentAliases) continue;
    const peerRoot = peer.cwd ? await fs.realpath(peer.cwd).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return null;
      throw error;
    }) : null;
    // A basename identifies a repository, not its publisher. Independent
    // copies in available unrelated roots do not contribute files here.
    // Retained sources survive cwd changes; unavailable legacy aliases with
    // matching publications remain ambiguous and therefore fail closed.
    const matches = sourceIds.has(peer.workspaceId) || peerRoot === canonicalCwd
      || (published && peerRoot === null && !knownOrigins.has(peer.id))
      || (!entries.some(entry => entry.kind === "reader") && peer.cwd && await legacyRepositoryRootMayMatch(peer.cwd, canonicalCwd));
    if (matches) {
      sourceIds.add(peer.workspaceId);
      if (published) recognizedNames.add(name);
    }
  }
  if ([...publishedNames].some(name => !recognizedNames.has(name))) throw forbidden("Published repository has no retained workspace provenance");
  // Configured folders can contain project files before any task has an
  // execution workspace. Read access must include their current aliases too.
  const configured = await tx.select({ projectId: projectWorkspaces.projectId, cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces).where(eq(projectWorkspaces.companyId, input.companyId));
  // Retain the privacy owner, not its disposable workspace configuration.
  // Execution sources may later lose their project FK; retained files must not.
  const sourceProjectIds = new Set(entries.filter(entry => entry.kind === "project_source").map(entry => entry.scopeId));
  if (sourceIds.size) {
    const owners = await tx.select({ projectId: executionWorkspaces.projectId }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, input.companyId), or(...[...sourceIds].map(id => eq(executionWorkspaces.id, id)))));
    for (const owner of owners) if (owner.projectId) sourceProjectIds.add(owner.projectId);
  }
  for (const source of configured) {
    if (!source.cwd || sourceProjectIds.has(source.projectId)) continue;
    const sourceRoot = await fs.realpath(source.cwd).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return null;
      throw error;
    });
    if (sourceRoot !== canonicalCwd) continue;
    sourceProjectIds.add(source.projectId);
  }
  return { canonicalCwd, rootKey, entries, sourceIds, sourceProjectIds };
}

async function assertRootProjectAccess(db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, projectIds: Set<string>) {
  for (const projectId of projectIds) {
    const [project] = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, projectId), eq(projects.companyId, companyId), await projectReadSqlCondition(db, actor)));
    if (!project) throw forbidden("Workspace source project is no longer accessible");
    await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, projectId);
  }
}

/** File readers share admission's source closure, without changing root policy. */
export async function assertExecutionWorkspaceRootReadAccess(db: Db | DbTransaction, input: {
  companyId: string; cwd: string; actor: AuthorizationActor; sourceWorkspaceId?: string;
}): Promise<void> {
  const { sourceIds, sourceProjectIds } = await resolveRepositoryRootSources(db, { ...input, inspectCurrentAliases: true });
  for (const sourceId of sourceIds) await assertTaskWorkspaceAccess(db, input.actor, input.companyId, sourceId);
  await assertRootProjectAccess(db, input.actor, input.companyId, sourceProjectIds);
}

/** Workspace aggregate child. It owns acquisition receipts, never task binding or provider sessions. */
export function executionWorkspaceRepositoryService(db: Db) {
  async function catalog(companyId: string, userId: string | null, localTrusted: boolean) {
    return (await toolAccessService(db).listProjectRepositories(companyId, userId, localTrusted)).repositories;
  }
  async function requiresAnonymousAcquisition(reader: Db | DbTransaction, input: {
    issue: typeof issues.$inferSelect; workspace: typeof executionWorkspaces.$inferSelect | null;
    agentId?: string | null; runId?: string | null;
  }) {
    const { issue, workspace } = input;
    const agentId = input.agentId ?? issue.assigneeAgentId;
    const [agent] = agentId ? await reader.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, issue.companyId))) : [];
    if (agentId && !agent) throw forbidden("Task repository agent is unavailable");
    const [project] = issue.projectId ? await reader.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, issue.companyId))) : [];
    const [workspaceSourceProject] = workspace?.projectId ? await reader.select().from(projects).where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, issue.companyId))) : [];
    const runId = input.runId ?? issue.executionRunId;
    const [run] = runId ? await reader.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, issue.companyId))) : [];
    if (runId && (!run || (input.runId && run.agentId !== agentId) || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== issue.id)) {
      throw forbidden("Task repository run identity is unavailable");
    }
    const trust = resolveCoreTrustPreset({ companyId: issue.companyId, agent, project, workspaceSourceProject, issue,
      run: run ? { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } : null });
    if (trust.kind === "denied") throw forbidden(trust.detail);
    return trust.kind === "low_trust_review";
  }
  async function lockRootPolicies(tx: DbTransaction, companyId: string) {
    // Acquire before task/workspace row locks. Hold only for policy and receipt
    // transactions, never Git, provider execution, or snapshot capture.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`task-repository-roots:${companyId}`}, 0))`);
  }
  async function reserveRootPolicy(tx: DbTransaction, companyId: string, cwd: string, mode: "anonymous_only" | "managed") {
    const canonicalCwd = await canonicalRepositoryRoot(cwd);
    const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
    const [existing] = await tx.select().from(executionWorkspaceRepositoryRoots).where(and(
      eq(executionWorkspaceRepositoryRoots.companyId, companyId), eq(executionWorkspaceRepositoryRoots.rootKey, rootKey)));
    if (existing && (existing.canonicalCwd !== canonicalCwd || existing.mode !== mode)) throw forbidden(lowTrustRepositoryMessage);
    if (mode === "anonymous_only") {
      // Legacy receipts predate root reservations. Even pending/staging work
      // can publish after admission, so no managed intent in this root is safe.
      const managed = await tx.select({ cwd: executionWorkspaces.cwd, repositoryIdentity: executionWorkspaceRepositories.repositoryIdentity }).from(executionWorkspaceRepositories)
        .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
        .where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaces.companyId, companyId),
          isNotNull(executionWorkspaceRepositories.catalogRepositoryId)));
      if (managed.length) {
        const namespace = path.join(canonicalCwd, ".paperclip-repositories");
        const namespaceEntry = await fs.lstat(namespace).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (namespaceEntry) {
          if (!namespaceEntry.isDirectory() || namespaceEntry.isSymbolicLink() || await fs.realpath(namespace) !== namespace) {
            throw forbidden(lowTrustRepositoryMessage);
          }
          // An unreadable/moved legacy alias cannot disprove published private
          // bytes in this readable root. Markers are agent-writable, so none can
          // authorize this collision: choose a fresh root even if these bytes
          // were acquired anonymously. Check existing reservations too, since
          // older versions may have admitted this root before fencing it.
          for (const identity of new Set(managed.map(peer => peer.repositoryIdentity))) {
            const entry = await fs.lstat(path.join(canonicalCwd, taskRepositoryRelativePath(identity))).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (entry) throw forbidden(lowTrustRepositoryMessage);
          }
        }
      }
      if (!existing) for (const peer of managed) {
        if (peer.cwd && await legacyRepositoryRootMayMatch(peer.cwd, canonicalCwd)) throw forbidden(lowTrustRepositoryMessage);
      }
    }
    if (!existing) await tx.insert(executionWorkspaceRepositoryRoots).values({ companyId, canonicalCwd, rootKey, mode });
    return canonicalCwd;
  }
  type RootReader = { runId: string; issueId: string; agentId: string };
  async function authorizeRootAccess(tx: DbTransaction, input: {
    companyId: string; cwd: string; sourceWorkspaceId?: string; reader?: RootReader; actor?: AuthorizationActor; preserveOwnAdmission?: boolean;
  }) {
    const { canonicalCwd, rootKey, entries, sourceIds, sourceProjectIds } = await resolveRepositoryRootSources(tx, input);
    const readers = entries.filter(entry => entry.kind === "reader");
    if (input.reader && !readers.some(reader => reader.scopeId === input.reader!.runId)) {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.reader.runId), eq(heartbeatRuns.companyId, input.companyId)));
      readers.push({ id: randomUUID(), companyId: input.companyId, rootKey, canonicalCwd, kind: "reader", scopeId: input.reader.runId,
        issueId: input.reader.issueId, agentId: input.reader.agentId, responsibleUserId: run?.responsibleUserId ?? null, createdAt: new Date(), updatedAt: new Date() });
    }
    // Heartbeat owns ordinary admission to this task's already-authorized
    // folder. Avoid adding acquisition permissions when it is the only task
    // and has no acquisition. Any other task/source requires the full closure.
    const ownAdmissionOnly = input.preserveOwnAdmission && input.reader && input.sourceWorkspaceId
      && sourceIds.size === 1 && sourceIds.has(input.sourceWorkspaceId)
      && readers.every(reader => reader.issueId === input.reader!.issueId);
    for (const reader of readers) {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, reader.scopeId), eq(heartbeatRuns.companyId, input.companyId)));
      const [agent] = reader.agentId ? await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, reader.agentId), eq(agents.companyId, input.companyId))) : [];
      const [issue] = reader.issueId ? await tx.select().from(issues).where(and(eq(issues.id, reader.issueId), eq(issues.companyId, input.companyId))) : [];
      if (!run || !agent || !issue || run.agentId !== reader.agentId || run.responsibleUserId !== reader.responsibleUserId
        || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== reader.issueId) {
        throw forbidden("Repository root retains a reader whose identity is no longer available");
      }
      const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId: input.companyId,
        agentId: reader.agentId!, runId: reader.scopeId, onBehalfOfUserId: reader.responsibleUserId === "local-board" ? null : reader.responsibleUserId };
      await assertRootProjectAccess(tx, actor, input.companyId, sourceProjectIds);
      if (ownAdmissionOnly) {
        const [ownSource] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
          eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.sourceWorkspaceId!),
          // Check both privacy principals without repeating the membership
          // admission gate that heartbeat already owns for this exact task.
          await executionWorkspaceReadSqlCondition(tx, { ...actor, onBehalfOfUserId: null }),
          actor.onBehalfOfUserId ? await executionWorkspaceReadSqlCondition(tx, {
            type: "board", userId: actor.onBehalfOfUserId, ignoreInstanceAdmin: true,
          }) : undefined));
        if (!ownSource) throw forbidden("Task workspace access is no longer available");
      } else for (const sourceId of sourceIds) await assertTaskWorkspaceAccess(tx, actor, input.companyId, sourceId);
      const sourceWorkspaces = sourceIds.size ? await tx.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, input.companyId), or(...[...sourceIds].map(id => eq(executionWorkspaces.id, id))))) : [];
      for (const sourceWorkspace of sourceWorkspaces.length ? sourceWorkspaces : [null]) {
        if (await requiresAnonymousAcquisition(tx, { issue, workspace: sourceWorkspace, agentId: reader.agentId!, runId: reader.scopeId })) {
          // Retained readers cannot gain managed bytes after their task, agent,
          // run, or any retained physical source becomes anonymous-only.
          await reserveRootPolicy(tx, input.companyId, canonicalCwd, "anonymous_only");
        }
      }
    }
    if (input.actor) {
      await assertRootProjectAccess(tx, input.actor, input.companyId, sourceProjectIds);
      for (const sourceId of sourceIds) await assertTaskWorkspaceAccess(tx, input.actor, input.companyId, sourceId);
    }
    for (const sourceId of sourceIds) {
      if (!entries.some(entry => entry.kind === "source" && entry.scopeId === sourceId)) {
        await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, rootKey, canonicalCwd, kind: "source", scopeId: sourceId });
      }
    }
    for (const sourceId of sourceProjectIds) {
      if (!entries.some(entry => entry.kind === "project_source" && entry.scopeId === sourceId)) {
        await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, rootKey, canonicalCwd, kind: "project_source", scopeId: sourceId });
      }
    }
    for (const reader of readers) {
      if (!entries.some(entry => entry.kind === "reader" && entry.scopeId === reader.scopeId)) await tx.insert(executionWorkspaceRepositoryAccess).values(reader);
    }
  }
  async function reserveRootAccess(input: Parameters<typeof authorizeRootAccess>[1]) {
    return db.transaction(async tx => {
      await lockRootPolicies(tx, input.companyId);
      await authorizeRootAccess(tx, input);
    });
  }
  async function reserveAdmissionRoot(companyId: string, cwd: string, mode: "anonymous_only" | "managed") {
    return db.transaction(async tx => {
      await lockRootPolicies(tx, companyId);
      return reserveRootPolicy(tx, companyId, cwd, mode);
    });
  }
  async function request(input: { companyId: string; issueId: string; actor: AuthorizationActor; request: PrepareWorkspaceRepository }) {
    const parsed = prepareWorkspaceRepositorySchema.parse(input.request);
    const [requestedIssue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), await issueReadSqlCondition(db, input.actor)));
    if (!requestedIssue) throw notFound("Task not found");
    const issueResource = (issue: typeof issues.$inferSelect) => ({ type: "issue" as const, companyId: issue.companyId, issueId: issue.id,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId });
    const decision = await authorizationService(db).decide({ actor: input.actor, action: "issue:mutate", resource: issueResource(requestedIssue) });
    if (!decision.allowed) throw forbidden("Task workspace modification is not allowed");
    let userId = input.actor.userId ?? null;
    let localTrusted = input.actor.source === "local_implicit";
    if (input.actor.type === "agent") {
      if (input.actor.source !== "agent_jwt" || !input.actor.agentId || !input.actor.runId || input.actor.companyId !== input.companyId) throw forbidden("Repository preparation requires an authenticated task run");
      const identity = await captureRunIdentity(db, { companyId: input.companyId, agentId: input.actor.agentId, runId: input.actor.runId });
      const runIssueId = identity.run.nativeIssueId ?? identity.run.contextSnapshot?.issueId;
      if (runIssueId !== input.issueId) throw forbidden("Repository preparation is scoped to the current task");
      userId = identity.run.responsibleUserId;
      localTrusted = userId === "local-board";
      if (!userId) throw forbidden("Repository access requires a responsible user");
    }
    const available = await catalog(input.companyId, userId, localTrusted);
    const requestedRef = parsed.ref ?? "HEAD";
    const receipt = await db.transaction(async tx => {
      await lockRootPolicies(tx, input.companyId);
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), await issueReadSqlCondition(tx, input.actor))).for("no key update");
      if (!issue) throw notFound("Task not found");
      const currentDecision = await authorizationService(tx).decide({ actor: input.actor, action: "issue:mutate", resource: issueResource(issue) });
      if (!currentDecision.allowed) throw forbidden("Task workspace modification is not allowed");
      if (input.actor.type === "agent" && !["standard", "skill_test"].includes(issue.workMode)) throw forbidden("Repository preparation is unavailable in Ask or Plan mode");
      if (!issue.executionWorkspaceId) throw conflict("The task has no admitted workspace yet. Start it once before preparing a repository.");
      if (!(await canActorReadExecutionWorkspace(db, input.actor, issue.executionWorkspaceId))) throw notFound("Execution workspace not found");
      // Serialize receipts across tasks without blocking unchanged-ID foreign-key reads.
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, issue.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId))).for("no key update");
      if (!workspace || workspace.status !== "active") throw conflict("Execution workspace is unavailable");
      await assertTaskWorkspaceAccess(tx, input.actor, input.companyId, workspace.id, { write: true, issueId: input.issueId });
      const anonymousOnly = await requiresAnonymousAcquisition(tx, { issue, workspace,
        agentId: input.actor.agentId, runId: input.actor.runId });
      const source = resolveAcquisitionSource(parsed.repository, available, anonymousOnly);
      if (anonymousOnly || source.catalogRepositoryId) {
        if (!workspace.cwd) throw conflict("The task workspace has no directory for repository preparation");
        await reserveRootPolicy(tx, input.companyId, workspace.cwd, anonymousOnly ? "anonymous_only" : "managed");
      }
      if (!workspace.cwd) throw conflict("The task workspace has no directory for repository preparation");
      await authorizeRootAccess(tx, { companyId: input.companyId, cwd: workspace.cwd, sourceWorkspaceId: workspace.id, actor: input.actor });
      const existing = await tx.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id), or(eq(executionWorkspaceRepositories.repositoryIdentity, source.repositoryIdentity), sql`${executionWorkspaceRepositories.requestKeys} ? ${parsed.requestKey}`)));
      for (const row of existing) {
        assertAcquisitionReceipt(row, anonymousOnly);
        assertRepositoryRetryMatches(row, source.repositoryIdentity, requestedRef);
      }
      if (existing[0]) {
        const row = existing[0];
        if (!row.requestKeys.includes(parsed.requestKey)) {
          const [updated] = await tx.update(executionWorkspaceRepositories).set({ requestKeys: [...row.requestKeys, parsed.requestKey] }).where(eq(executionWorkspaceRepositories.id, row.id)).returning();
          return updated;
        }
        return row;
      }
      const [row] = await tx.insert(executionWorkspaceRepositories).values({ companyId: input.companyId, executionWorkspaceId: workspace.id, requestedByIssueId: input.issueId, ...source, relativePath: taskRepositoryRelativePath(source.repositoryIdentity), requestedRef, requestKey: parsed.requestKey, requestKeys: [parsed.requestKey] }).returning();
      const canonicalCwd = await canonicalRepositoryRoot(workspace.cwd);
      await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId,
        rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), canonicalCwd, kind: "repository", scopeId: row.id });
      await tx.insert(activityLog).values({ companyId: input.companyId, actorType: input.actor.type === "agent" ? "agent" : "user", actorId: input.actor.agentId ?? input.actor.userId ?? "local-board", action: "workspace.repository.requested", entityType: "execution_workspace", entityId: workspace.id, runId: input.actor.runId ?? null, responsibleUserId: userId, details: { repositoryId: row.id, issueId: input.issueId, applies: "next_normal_admission" } });
      return row;
    });
    // No host-only checkout is represented as ready in an already admitted remote session.
    return { kind: "requires_next_admission" as const, applies: "next_normal_admission" as const, operationId: receipt.id, repository: receipt, reason: "immutable_admitted_workspace" };
  }
  async function list(companyId: string, workspaceId: string) {
    return db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId)));
  }
  /** Configured-source publication shares this root, but does not acquire a repository. */
  async function guardForPublication(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string }) {
    await db.transaction(async tx => {
      await lockRootPolicies(tx, input.companyId);
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
      if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id || !workspace.cwd
        || await canonicalRepositoryRoot(workspace.cwd) !== await canonicalRepositoryRoot(input.cwd)) {
        throw forbidden("Task repository publication binding is unavailable");
      }
      await requiresAnonymousAcquisition(tx, { issue, workspace, agentId: input.agentId, runId: input.runId });
      await authorizeRootAccess(tx, { companyId: input.companyId, cwd: input.cwd, sourceWorkspaceId: workspace.id, reader: input });
    });
  }
  /** Recovery keeps its admitted identity and folder; only fence future publication. */
  async function reserveForRecovery(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string }) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    if (!issue) throw forbidden("Task repository recovery identity is unavailable");
    if (!workspace) {
      // Older projectless native admissions used the run ID as a transient
      // workspace binding. Only the persisted exact native binding grants this exception.
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
      let execution;
      try { execution = parseNativeExecutionInput(run?.runnerProfileJson?.nativeExecutionInput); } catch { /* Fail closed below. */ }
      const binding = execution?.binding;
      if (input.workspaceId !== input.runId || run?.runtimeMode !== "native" || !binding
        || binding.companyId !== input.companyId || binding.runId !== input.runId
        || binding.agentId !== input.agentId || binding.issueId !== input.issueId
        || binding.executionWorkspaceId !== input.runId) {
        throw forbidden("Task repository recovery identity is unavailable");
      }
    }
    const anonymousOnly = await requiresAnonymousAcquisition(db, { issue, workspace: workspace ?? null, agentId: input.agentId, runId: input.runId });
    if (anonymousOnly) await reserveAdmissionRoot(input.companyId, input.cwd, "anonymous_only");
    else if ((await list(input.companyId, input.workspaceId)).some(row => row.catalogRepositoryId)) {
      await reserveAdmissionRoot(input.companyId, input.cwd, "managed");
    }
    await reserveRootAccess({ companyId: input.companyId, cwd: input.cwd, reader: input,
      ...(workspace ? { sourceWorkspaceId: workspace.id } : {}),
      preserveOwnAdmission: !(await list(input.companyId, input.workspaceId)).length });
  }
  /** Logical rows may deliberately name one physical folder. Reuse bytes only
   * after validating every published owner's retained privacy and source intent. */
  async function sharedPublicationPin(input: { issueId: string; row: RepositoryRow; root: string; actor: AuthorizationActor; anonymousOnly: boolean; ownership: { repositoryId?: string; pinnedCommit?: string } | null }) {
    const candidates = await db.select({ repository: executionWorkspaceRepositories, workspace: executionWorkspaces })
      .from(executionWorkspaceRepositories).innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
      .where(and(eq(executionWorkspaceRepositories.companyId, input.row.companyId), eq(executionWorkspaces.companyId, input.row.companyId),
        eq(executionWorkspaceRepositories.repositoryIdentity, input.row.repositoryIdentity), eq(executionWorkspaceRepositories.relativePath, input.row.relativePath)));
    let pin = input.row.pinnedCommit;
    for (const { repository, workspace } of candidates) {
      if (repository.id === input.row.id || !workspace.cwd) continue;
      const candidatePin = repository.pinnedCommit ?? (input.ownership?.repositoryId === repository.id ? input.ownership.pinnedCommit : null);
      // An intent that has not published anything cannot claim another task's checkout.
      if (!candidatePin || !/^[a-f0-9]{40,64}$/.test(candidatePin)) continue;
      if (await fs.realpath(workspace.cwd).catch(() => null) !== input.root) continue;
      assertAcquisitionReceipt(repository, input.anonymousOnly);
      assertRepositoryRetryMatches(repository, input.row.repositoryIdentity, input.row.requestedRef);
      if (!(await canActorReadExecutionWorkspace(db, input.actor, workspace.id))) throw forbidden("The shared repository retains files from a workspace outside this actor's access");
      await assertTaskWorkspaceAccess(db, input.actor, input.row.companyId, workspace.id, { write: true, issueId: input.issueId });
      if (pin && pin !== candidatePin) throw conflict("Shared repository publication receipts disagree; repair is required before reuse");
      pin = candidatePin;
    }
    return pin;
  }
  async function prepareForAdmission(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string; responsibleUserId: string | null }) {
    const rows = await list(input.companyId, input.workspaceId);
    const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId: input.companyId,
      agentId: input.agentId, runId: input.runId,
      // local-board is a server identity, not a membership record. Preserve the
      // agent's own authority rather than promoting it to a board actor.
      onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId };
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id) throw forbidden("Task repository workspace binding is unavailable");
    const anonymousOnly = await requiresAnonymousAcquisition(db, { issue, workspace: workspace ?? null, agentId: input.agentId, runId: input.runId });
    // Ordinary admission without acquisitions is owned by heartbeat, not this mutation service.
    if (!rows.length) {
      if (anonymousOnly) await reserveAdmissionRoot(input.companyId, input.cwd, "anonymous_only");
      await reserveRootAccess({ companyId: input.companyId, cwd: input.cwd, reader: input,
        sourceWorkspaceId: workspace.id, preserveOwnAdmission: true });
      return [];
    }
    await assertTaskWorkspaceAccess(db, actor, input.companyId, input.workspaceId, { write: true, issueId: input.issueId });
    const root = await fs.realpath(input.cwd);
    const available = anonymousOnly ? [] : await catalog(input.companyId, input.responsibleUserId, input.responsibleUserId === "local-board");
    const resolveAuth = createGitRemoteAuthProvider(db, input.companyId, { issueId: input.issueId, heartbeatRunId: input.runId, agentId: input.agentId, responsibleUserId: input.responsibleUserId });
    // Validate every receipt before reading or transferring any prepared bytes.
    const sources = rows.map(row => {
      assertAcquisitionReceipt(row, anonymousOnly);
      return resolveAcquisitionSource(row.catalogRepositoryId ? { kind: "catalog", id: row.catalogRepositoryId } : { kind: "url", url: row.repoUrl }, available, anonymousOnly);
    });
    if (anonymousOnly || sources.some(source => source.catalogRepositoryId)) {
      const reservedRoot = await reserveAdmissionRoot(input.companyId, root, anonymousOnly ? "anonymous_only" : "managed");
      if (reservedRoot !== root) throw conflict("Repository workspace root changed during admission");
    }
    await reserveRootAccess({ companyId: input.companyId, cwd: root, sourceWorkspaceId: input.workspaceId, reader: input });
    const repositoryRoot = path.join(root, ".paperclip-repositories");
    await fs.mkdir(repositoryRoot, { recursive: true });
    if ((await fs.lstat(repositoryRoot)).isSymbolicLink() || await fs.realpath(repositoryRoot) !== repositoryRoot) throw conflict("Repository directory escapes the task workspace");
    // Incomplete clones belong to the runtime tree, which is excluded from
    // transfer and recovery. The published namespace contains checkouts only.
    let stagingParent = root;
    for (const name of [".paperclip-runtime", "repository-staging"]) {
      stagingParent = path.join(stagingParent, name);
      await fs.mkdir(stagingParent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const entry = await fs.lstat(stagingParent);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(stagingParent) !== stagingParent) {
        throw conflict("Repository staging directory escapes the task workspace");
      }
    }
    // Self-ignore before any clone writes, including when the task directory
    // is a subfolder of another checkout. Never follow a supplied ignore file.
    const ignorePath = path.join(stagingParent, ".gitignore");
    const ignoreEntry = await fs.lstat(ignorePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (ignoreEntry && (!ignoreEntry.isFile() || ignoreEntry.isSymbolicLink())) {
      throw conflict("Repository staging ignore file is not a regular file");
    }
    const ignoreTemporary = path.join(stagingParent, `.ignore-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(ignoreTemporary, "*\n", { flag: "wx", mode: 0o600 });
      await fs.rename(ignoreTemporary, ignorePath);
    } finally { await fs.rm(ignoreTemporary, { force: true }); }
    await ensureManagedRepositoriesIgnored(root);
    const prepared: Array<{ id: string; cwd: string; repoUrl: string; relativePath: string; pinnedCommit: string; branchName: string | null }> = [];
    for (const [index, row] of rows.entries()) {
      const source = sources[index];
      if (source.repositoryIdentity !== row.repositoryIdentity || row.relativePath !== taskRepositoryRelativePath(row.repositoryIdentity)) throw conflict("Repository preparation receipt does not match its source");
      const cwd = path.join(root, row.relativePath);
      await withDirectoryPublicationLock(cwd, async () => {
        const existing = await fs.lstat(cwd).catch(() => null);
        if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || await fs.realpath(cwd) !== cwd)) throw conflict("Repository checkout path is not a contained directory");
        if (existing) {
          const gitDir = path.join(cwd, ".git");
          const metadata = await fs.lstat(gitDir).catch(() => null);
          if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(gitDir) !== gitDir) throw conflict("Repository Git metadata escapes the managed checkout");
        }
        // Uncataloged URLs may use anonymous public Git only. Never borrow a user's/company's credential for an arbitrary URL.
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        anonymous.env = { ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
        await db.update(executionWorkspaceRepositories).set({ state: "preparing", catalogRepositoryId: source.catalogRepositoryId, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
        try {
          const ownershipPath = path.join(cwd, ".git", "paperclip-workspace-owner.json");
          const readOwnership = async () => {
            const handle = await fs.open(ownershipPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
            if (!handle) return null;
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > 4096) return null;
              const bytes = Buffer.alloc(4097);
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
              return bytesRead <= 4096 ? JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) : null;
            } catch { return null; } finally { await handle.close(); }
          };
          const initialOwnership = await readOwnership();
          const authorizedPin = await sharedPublicationPin({ issueId: input.issueId, row, root, actor, anonymousOnly, ownership: initialOwnership });
          if (existing && !authorizedPin && initialOwnership?.repositoryId !== row.id) {
            throw conflict("Repository directory has no matching preparation receipt; repair it before retrying");
          }
          const result = await materializeManagedProjectWorkspace(cwd, {
            repoUrl: row.repoUrl,
            stagingParent,
            repoRef: authorizedPin ?? (row.requestedRef === "HEAD" ? null : row.requestedRef),
            resolveGitAuth: source.catalogRepositoryId ? resolveAuth : async () => anonymous,
            beforePublish: async cloneCwd => {
              await reserveRootAccess({ companyId: input.companyId, cwd: root, sourceWorkspaceId: input.workspaceId, reader: input });
              const pinnedCommit = (await execFile("git", ["-C", cloneCwd, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
              await fs.writeFile(path.join(cloneCwd, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ version: 1, repositoryId: row.id, pinnedCommit }), { flag: "wx", mode: 0o600 });
            },
          });
          if (result.warning) throw conflict(result.warning);
          const git = async (...args: string[]) => (await execFile("git", ["-C", cwd, ...args], { timeout: 30_000 })).stdout.trim();
          const origin = normalizeProjectRepositoryUrl(await git("remote", "get-url", "origin"));
          if (origin.url.toLowerCase() !== row.repositoryIdentity) throw conflict("Repository checkout belongs to a different origin");
          const ownership = await readOwnership();
          if (!authorizedPin && (ownership?.repositoryId !== row.id || !/^[a-f0-9]{40,64}$/.test(ownership.pinnedCommit))) throw conflict("Repository publication has no valid preparation receipt");
          // The pre-publication commit survives a crash before the database update.
          const pinnedCommit: string = authorizedPin ?? ownership.pinnedCommit;
          const branchName = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => null);
          await db.update(executionWorkspaceRepositories).set({ state: "ready", pinnedCommit, branchName, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
          prepared.push({ id: row.id, cwd, repoUrl: row.repoUrl, relativePath: row.relativePath, pinnedCommit, branchName });
        } catch (error) {
          await db.update(executionWorkspaceRepositories).set({ state: "needs_repair", failureCode: "repository_preparation_failed", updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
          throw error;
        }
      });
    }
    return prepared;
  }
  return { request, list, prepareForAdmission, reserveForRecovery, guardForPublication };
}
