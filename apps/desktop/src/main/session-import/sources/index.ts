/** 来源适配器注册表：顺序即界面「全部来源」菜单与空状态里的顺序。 */

import type { ImportSourceId, SourceAdapter } from '../types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { piAdapter } from './pi.js';

export const SOURCE_ADAPTERS: SourceAdapter[] = [
  claudeAdapter,
  codexAdapter,
  piAdapter,
];

export function adapterFor(id: ImportSourceId): SourceAdapter | undefined {
  return SOURCE_ADAPTERS.find((a) => a.id === id);
}
