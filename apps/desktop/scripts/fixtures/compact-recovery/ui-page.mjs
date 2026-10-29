import assert from 'node:assert/strict';

export default {
  name: 'compact-recovery',
  entry: './compact-recovery-fixture.tsx',
  viewport: { width: 560, height: 320 },
  real: 'ErrorBanner, ErrorMessageCard, legacy error classification and localized compact recovery guidance',
  notCovered: 'Live provider compaction and host rollover; recovery behavior is covered by targeted tests',
  cases: {
    default: { about: 'Encrypted compact failure retains Retry and explains the cause' },
    legacy: { about: 'Older host error no longer claims the input is oversized' },
    history: { about: 'Persisted compact error displays the corrected explanation' },
    'legacy-split': { about: 'Older host live error with discarded ciphertext details' },
    'history-split': { about: 'Persisted legacy error with discarded ciphertext details' },
    narrow: { about: 'Recovery guidance at 320 px', viewport: { width: 320, height: 440 } },
  },
  async check(page, ui) {
    assert.ok(await page.getByText(await ui.t('chat.errorBanner.remoteCompactEncryptedContent'), { exact: true }).isVisible());
    assert.equal(await page.getByText(await ui.t('chat.errorBanner.contextOverflow'), { exact: true }).count(), 0);
    if (!ui.case.startsWith('history')) {
      await page.getByTitle(await ui.t('chat.errorBanner.retryTitle'), { exact: true }).click();
      assert.equal(await page.locator('[data-retries]').getAttribute('data-retries'), '1');
    }
  },
};
