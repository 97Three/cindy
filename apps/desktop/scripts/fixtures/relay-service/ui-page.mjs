import assert from 'node:assert/strict';

export default {
  name: 'relay-service',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 720 },
  real: 'RelayServicePanel and useSelfHostedRelayState: route list, icon-only switch/remove actions, server details, join and host dialogs',
  notCovered: 'Real SSH, deployment, certificate issuance, joining and switching; covered separately by deployment/runtime unit tests',
  cases: {
    default: { about: 'Official relay in use; a deployed server relay is available to switch to' },
    server: { about: 'Server relay in use: details with devices, certificate and version', viewport: { width: 360, height: 900 } },
    host: { about: 'This computer is the relay: settings icon and its add-device area' },
    'retry-replace': { about: 'A failed replacement rechecks the server and asks again before clearing its relay' },
    'retry-own': { about: 'A failed deployment retains its elapsed time and retries its own relay without clearing it' },
    'retry-check-error': { about: 'A failed retry check stays in the deployment dialog with a visible error' },
    'join-error': { about: 'The completed deployment shows join-link failures inside the open dialog' },
  },
  async check(page, ui) {
    const route = 'settings.remoteControl.relay.route';
    const relay = 'settings.remoteControl.relay';
    const removeLabel = await ui.t(`${relay}.manage.remove`);
    const serverRow = page.getByRole('listitem').filter({ hasText: 'Test' });
    const serverButtons = serverRow.getByRole('button');
    // #7921 review:真实组件回归替换重试、失败用时和弹窗内错误；旧场景只有成功状态。
    if (ui.case.startsWith('retry-') || ui.case === 'join-error') {
      const deploy = `${relay}.deploy`;
      await page.getByRole('button', { name: await ui.t(`${route}.resume`), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${deploy}.title`), exact: true });
      await dialog.waitFor();
      if (ui.case === 'retry-own') {
        await dialog.getByText(await ui.t(`${deploy}.elapsed`, { time: '0:15' }), { exact: true }).waitFor({ timeout: 3_000 });
        await ui.capture('failed-elapsed');
      }
      await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).click();
      if (ui.case === 'retry-replace') {
        const confirmation = page.getByRole('alertdialog', { name: await ui.t(`${deploy}.replaceTitle`), exact: true });
        await confirmation.waitFor({ timeout: 3_000 });
        await ui.capture('replacement-confirmation');
        await confirmation.getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true }).click();
        await dialog.waitFor();
        assert.ok(await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).isVisible());
        await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).click();
        await confirmation.getByRole('button', { name: await ui.t(`${deploy}.submitReplace`), exact: true }).click();
      }
      if (ui.case === 'retry-check-error') {
        await dialog.getByRole('alert').filter({ hasText: await ui.t(`${relay}.errors.PORT_BUSY_CONTAINER`, { detail: 'demo-nginx' }) }).waitFor({ timeout: 3_000 });
        assert.ok(await dialog.getByRole('button', { name: await ui.t(`${deploy}.retry`), exact: true }).isVisible());
        await ui.capture('retry-check-error');
      } else {
        await dialog.getByText(await ui.t(`${relay}.dialog.doneTitle`, { name: 'Test' }), { exact: true }).waitFor({ timeout: 3_000 });
        if (ui.case === 'join-error') {
          await dialog.getByRole('alert').filter({ hasText: await ui.t(`${relay}.errors.FAILED`) }).waitFor({ timeout: 3_000 });
          await ui.capture('join-link-error');
        }
      }
    } else if (ui.case === 'default') {
      // 切换在前、删除在后,都只有图标。
      const switchLabel = await ui.t(`${route}.useNamed`, { name: 'Test' });
      assert.equal(await serverButtons.count(), 2);
      assert.equal(await serverButtons.nth(0).getAttribute('aria-label'), switchLabel);
      assert.equal(await serverButtons.nth(1).getAttribute('aria-label'), removeLabel);
      assert.equal((await serverButtons.nth(0).innerText()).trim(), '');
      // 右侧只放图标、贴右对齐:只有一个图标的行它就在最右边;正在使用的绿点在线路名旁边,
      // 不挤进图标列(用户 2026-10-29 反馈没对齐、单个切换图标要靠右)。
      const hostTitle = await ui.t(`${route}.hostTitle`);
      const hostSwitch = page
        .getByRole('listitem')
        .filter({ hasText: hostTitle })
        .getByRole('button', { name: await ui.t(`${route}.useNamed`, { name: hostTitle }), exact: true });
      const inUse = page.getByRole('listitem').first().getByRole('img', { name: await ui.t(`${relay}.server.inUse`), exact: true });
      const [serverSwitchBox, removeBox, hostSwitchBox, inUseBox] = await Promise.all(
        [serverButtons.nth(0), serverButtons.nth(1), hostSwitch, inUse].map((locator) => locator.boundingBox()),
      );
      assert.equal(hostSwitchBox.x + hostSwitchBox.width, removeBox.x + removeBox.width);
      assert.ok(removeBox.x >= serverSwitchBox.x + serverSwitchBox.width);
      assert.ok(inUseBox.x + inUseBox.width < serverSwitchBox.x);
      // 加入别的中转用窗口,不在列表下面展开。
      await page.getByRole('button', { name: await ui.t(`${relay}.actions.join`), exact: true }).click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${relay}.join.title`) });
      await dialog.waitFor();
      await ui.capture('join-dialog');
      await dialog.getByRole('button', { name: await ui.t(`${relay}.join.cancel`), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    } else if (ui.case === 'server') {
      assert.ok(await serverRow.getByText(await ui.t(`${relay}.manage.deviceCount`, { count: 3 }), { exact: true }).isVisible());
      assert.equal(await serverRow.getByRole('button', { name: removeLabel, exact: true }).count(), 1);
    } else {
      const settings = page.getByRole('button', { name: await ui.t(`${relay}.actions.editHost`), exact: true });
      await settings.click();
      const dialog = page.getByRole('dialog', { name: await ui.t(`${route}.hostTitle`) });
      await dialog.waitFor();
      await ui.capture('host-dialog');
    }
  },
};
