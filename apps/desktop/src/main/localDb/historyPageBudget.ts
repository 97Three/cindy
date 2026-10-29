/** Soft budget for complete history records, before the tool's small envelope.
 * A single oversized record always makes progress and remains readable in full.
 * Never slice content: callers advance their native cursor at the last kept row.
 */
export function historyPageWithinBudget<T>(items: T[]): T[] {
  let bytes = 2; // array brackets
  let count = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (count ? 1 : 0);
    if (count > 0 && bytes + size > 64 * 1024) break;
    bytes += size;
    count++;
  }
  return count === items.length ? items : items.slice(0, count);
}
