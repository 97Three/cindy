import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { getSessionListActivityAt, resolveSessionRightStatus } from '@cindy/maker-shared/session-activity';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botSessionLinks, sessions } from '../localDb/schema.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';
import type { PluginObserveTask } from '../../shared/pluginObserve.js';
import { readCanonicalSessionActivity } from './sessionActivityProjection.js';

const MAX_PROJECT_TASKS = 200;
const projectKey = (dir: string) => projectKeyComparisonKey(`local:${dir}`, process.platform);

/**
 * Metadata-only task list for one registered local project. Uses the same
 * visibility rules as plugin targets plus archived tasks, and the canonical
 * activity read model so status matches the sidebar.
 */
export async function listPluginObserveTasks(project: string): Promise<PluginObserveTask[]> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const key = projectKey(project);
  const registered = (await listRecentWorkdirs(snapshot.client)).some((row) => row.exists && projectKey(row.path) === key);
  if (!key || !registered) throw new Error('TARGET_UNAVAILABLE');
  const rows = await snapshot.client.drizzle
    .select({
      id: sessions.id,
      title: sessions.title,
      agentKind: sessions.agentKind,
      status: sessions.status,
      workingDir: sessions.workingDir,
      lastActivityAt: sessions.lastActivityAt,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
    .where(
      and(
        or(eq(sessions.status, 'active'), eq(sessions.status, 'archived')),
        eq(sessions.workspaceKind, 'project'),
        isNull(sessions.remoteHostId),
        isNull(sessions.agentDeviceId),
        isNull(sessions.hiddenAt),
        isNull(botSessionLinks.id),
        ne(sessions.source, 'bot'),
        ne(sessions.source, 'review'),
        or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
      ),
    );
  const matched = rows
    .filter((row) => row.workingDir !== null && projectKey(row.workingDir) === key)
    .sort((a, b) => getSessionListActivityAt(b) - getSessionListActivityAt(a))
    .slice(0, MAX_PROJECT_TASKS);
  const tasks = await Promise.all(matched.map(async (row): Promise<PluginObserveTask> => {
    const status = resolveSessionRightStatus(await readCanonicalSessionActivity(row.id));
    return {
      id: row.id,
      title: row.title,
      agentKind: row.agentKind,
      archived: row.status === 'archived',
      status: status === 'time' ? 'idle' : status,
      lastActivityAt: getSessionListActivityAt(row),
    };
  }));
  if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
  return tasks;
}

/** Only tasks the plugin could list may be opened. */
export async function assertPluginObservableTask(taskId: string): Promise<void> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('HOST_NOT_READY');
  const [row] = await snapshot.client.drizzle
    .select({ workingDir: sessions.workingDir })
    .from(sessions)
    .where(eq(sessions.id, taskId))
    .limit(1);
  if (!row?.workingDir || !(await listPluginObserveTasks(row.workingDir)).some((task) => task.id === taskId))
    throw new Error('TARGET_UNAVAILABLE');
}
