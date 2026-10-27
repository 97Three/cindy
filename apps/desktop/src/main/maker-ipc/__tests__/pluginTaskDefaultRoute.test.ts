import { describe, expect, it } from 'vitest';

import { encodeCatalogModelPin } from '../../../shared/catalogModelPin.js';
import { auxiliaryChainSessionCandidates, pluginTaskSelectionIsOpen } from '../pluginTaskDefaultRoute.js';

describe('auxiliaryChainSessionCandidates', () => {
  // Rule: a plugin's own persistent task (no originating session) follows the
  // auxiliary chain instead of the new-task composer selection. tier: unit.
  it('maps catalog pins and lightweight profiles to session routes in chain order', () => {
    const refs = [
      encodeCatalogModelPin({ providerId: 'xd', agentKind: 'codex', model: 'deepseek/deepseek-v4-flash' }),
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      encodeCatalogModelPin({ providerId: 'xd', agentKind: 'codex', model: 'deepseek/deepseek-v4-flash' }),
      'not-a-ref',
    ];
    expect(auxiliaryChainSessionCandidates(refs)).toEqual([
      { agentKind: 'codex', providerId: 'xd', model: 'deepseek/deepseek-v4-flash' },
      { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.4-mini' },
      { agentKind: 'codex', providerId: 'xd', model: 'gpt-5.4-mini' },
    ]);
  });

  it('treats any explicit identifying field as a closed selection', () => {
    expect(pluginTaskSelectionIsOpen({})).toBe(true);
    expect(pluginTaskSelectionIsOpen({ effort: 'low' })).toBe(true);
    expect(pluginTaskSelectionIsOpen({ model: 'gpt-6.1-sol' })).toBe(false);
    expect(pluginTaskSelectionIsOpen({ providerId: 'openai' })).toBe(false);
  });
});
