import assert from 'node:assert/strict';

// Layout regression: a long source message used to be capped at 192px in a second
// scroller. jsdom cannot measure that failure; keep this in the Electron UI tier.
export default {
  name: 'thread-panels', entry: './fixture.tsx', viewport: { width: 960, height: 640 },
  real: 'BotDmThreadPanel, ChatThreadPanel, shared ThreadPanel/ThreadPanelRoot, BotGroupTimelineItem, Markdown, theme and translations',
  notCovered: 'Private ready-state task runtime (checked separately in isolated Desktop), model execution, real media upload and server persistence; attachment selection uses scenario host data',
  stubs: {
    'src/renderer/features/cc-agent/CCAgentSessionView': 'export const CCAgentSessionView = () => { throw new Error("Use full Desktop for ready-state task verification"); };',
    'src/renderer/lib/makerChatStore': { partial: 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => window.__threadRoot };' },
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => { throw new Error("Voice is outside this layout fixture"); };',
  },
  cases: {
    group: { about: 'Group topic with a long source message' },
    'group-attachments': { about: 'Thread + menu, image-only send and tray reset at narrow panel width' },
    default: { about: 'Private topic opening with the same long source message' },
    failed: { about: 'Private topic failure keeps the entire source and retry reachable' },
  },
  async ready(page) { await page.locator('aside [data-bot-group-message-id="root"], aside [data-dm-thread-root]').first().waitFor(); },
  async check(page, ui) {
    const panel = page.locator('aside');
    if (ui.case === 'group-attachments') {
      const more = panel.getByRole('button', { name: await ui.t('bots.groupChat.composer.more'), exact: true });
      await more.click();
      await page.getByRole('menuitem', { name: await ui.t('extraDirs.addFiles'), exact: true }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: await ui.t('bots.groupChat.composer.division'), exact: false }).count(), 0);
      await ui.capture('attachment-menu');
      await page.keyboard.press('Escape');
      await panel.locator('input[type="file"]').setInputFiles({
        name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('fixture-image-bytes'),
      });
      const send = panel.getByRole('button', { name: await ui.t('bots.groupChat.server.sendReply'), exact: true });
      await page.waitForFunction(() => document.querySelector('aside input[type="file"]') &&
        window.__threadSends.length === 0 && document.querySelector('aside img[alt="photo.png"]'));
      assert.equal(await send.isEnabled(), true);
      await ui.capture('image-ready');
      await send.click();
      await page.waitForFunction(() => window.__threadSends.length === 1);
      const [sent] = await page.evaluate(() => window.__threadSends);
      assert.equal(sent.rootId, 'root');
      assert.equal(sent.text, '');
      assert.equal(sent.attachments[0].name, 'photo.png');
      await send.waitFor({ state: 'visible' });
      assert.equal(await send.isDisabled(), true);
      await ui.capture('sent');
      return;
    }
    const root = ui.case === 'group' ? panel.locator('[data-bot-group-message-id="root"]') : panel.locator('[data-dm-thread-root]');
    const measurements = await root.evaluate(el => {
      const scrollers = [];
      for (let node = el; node && node.tagName !== 'ASIDE'; node = node.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(node).overflowY)) scrollers.push(node);
      }
      return { height: el.getBoundingClientRect().height, ownOverflow: el.scrollHeight - el.clientHeight,
        scrollers: scrollers.length, ownScroller: scrollers.includes(el) };
    });
    assert.ok(measurements.height > 192, 'long root is allowed its full natural height');
    assert.ok(measurements.ownOverflow <= 1, 'no content is hidden inside the root');
    assert.equal(measurements.scrollers, 1, 'one scroll owner for root and replies');
    assert.equal(measurements.ownScroller, false, 'root is not an independent scroll box');
    await panel.getByText('原消息开头 · Original message', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('root-top');
    await panel.getByText('原消息末尾 · End of original', { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('root-end');
    if (ui.case === 'failed') await panel.getByRole('button', { name: await ui.t('bots.retry'), exact: true }).click();
    await panel.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
    await page.locator('[data-closed]').waitFor({ state: 'attached' });
  },
};
