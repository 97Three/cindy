import assert from 'node:assert/strict';

// #8010 / UI integration: real discovery, catalog hooks, model panel and Worker form.
// Existing unified-model-rail fixtures supply providersOverride and never exercise
// B's directory. Minimum input: A controls B, B lists A and a B-only share.
// Only the preload transport is simulated; no login, network or Agent is invoked.
export default {
  name: 'controlled-model-catalog', entry: './fixture.tsx',
  viewport: { width: 780, height: 720 },
  real: 'ModelSelectorContent, useControlledModelLocations, useDeviceProviders, useAgentCapabilities, CreateWorkerPopover',
  notCovered: 'Real device-link transport, main authorization, actual Agent execution and persistence',
  cases: {
    default: { about: 'A controls B: choose A, B-only share, then B private source' },
    local: { about: 'Local catalog still includes private sources without remote reads' },
    worker: { about: 'Worker uses B-only share; creation returns the actual share ID' },
  },
  async check(page, ui) {
    if (ui.case === 'worker') {
      await page.getByRole('dialog').waitFor();
      await page.getByText('Shared Model', { exact: true }).first().waitFor();
      await ui.capture('worker-shared-model');
      await page.getByRole('button', { name: await ui.t('orca.createWorker.submit'), exact: true }).click();
      await page.waitForFunction(() => window.catalogAcceptance.selected() !== null);
      const selection = await page.evaluate(() => window.catalogAcceptance.selected());
      assert.equal(selection.agentDeviceId, 'share:b-only');
      assert.equal(selection.model, 'shared-model');
      assert.equal(selection.executionDeviceId, undefined);
      return;
    }
    const list = page.getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') });
    await list.waitFor();
    if (ui.case === 'local') {
      await list.getByText('A Private Model', { exact: true }).waitFor();
      assert.equal(await list.getByText('B Main Model', { exact: true }).count(), 0);
      assert.deepEqual(await page.evaluate(() => window.catalogAcceptance.calls), []);
      await ui.capture('local-private-models');
      return;
    }
    for (const step of [
      { rail: 'A Open · Computer A', model: 'A Open Model', id: 'a-open-model', source: 'device-a' },
      { rail: 'Shared · B-only share', model: 'Shared Model', id: 'shared-model', source: 'share:b-only' },
      { rail: 'B Private', model: 'B Private Model', id: 'b-private-model', source: null },
    ]) {
      await page.getByRole('button', { name: step.rail, exact: true }).click();
      await list.getByText(step.model, { exact: true }).waitFor();
      assert.equal(await list.getByText('A Private Model', { exact: true }).count(), 0);
      await ui.capture(step.id);
      await list.getByText(step.model, { exact: true }).click();
      await page.waitForFunction(id => window.catalogAcceptance.selected()?.modelId === id, step.id);
      const selected = await page.evaluate(() => window.catalogAcceptance.selected());
      assert.equal(selected.agentDevice?.deviceId ?? null, step.source);
    }
    const calls = await page.evaluate(() => window.catalogAcceptance.calls);
    assert.ok(calls.length > 0 && calls.every(call => call.host === 'device-b'));
  },
};
