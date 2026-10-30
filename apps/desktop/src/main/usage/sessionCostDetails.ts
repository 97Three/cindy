import { groupUsageCostRows, messageUsageCostRows } from '@cindy/maker-shared/usage-cost-details';
import type { DbClient } from '../localDb/client/DbClient.js';

/** Read the existing message ledger; billing remains owned by its original writers. */
export async function readSessionCostDetails(db: DbClient, sessionId: string, clientId?: string) {
  const rows = await db.query<{ clientId: string; role: string; agentMeta: string | null }>(
    `SELECT m.client_id AS clientId, m.role, m.agent_meta AS agentMeta
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.session_id = ? AND m.rewind_at IS NULL AND m.role IN ('user', 'assistant')
       AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
     ORDER BY m.created_at, m.rowid`,
    [sessionId],
  );
  let round = '';
  const parsed = rows.map((row) => {
    let meta: Record<string, unknown> = {};
    try {
      const value = JSON.parse(row.agentMeta ?? '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) meta = value;
    } catch {
      /* old metadata */
    }
    if (row.role === 'user' && meta.autoResume !== true) round = row.clientId;
    return { ...row, meta, round };
  });
  const targetIndex = clientId ? parsed.findIndex((row) => row.clientId === clientId) : -1;
  const target = parsed[targetIndex];
  if (clientId && !target) return [];
  return groupUsageCostRows(
    parsed
      .filter(
        (row, index) =>
          !clientId ||
          (index <= targetIndex &&
            (target?.round ? row.round === target.round : row.clientId === clientId)),
      )
      .flatMap((row) => messageUsageCostRows(row.meta, row.role)),
  );
}
