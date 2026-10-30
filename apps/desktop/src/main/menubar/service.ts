/**
 * macOS menu bar quota item: drives the native helper with the shared quota overview.
 *
 * Collection, caches and rebuild cadence live in `quota-overview/service.ts`, which this panel
 * holds while it is enabled (the iPhone widgets and other platforms' panels use the same
 * overview). This file only adds the panel's own parts: task activity, the remote-control
 * indicator, the low-quota notification and the helper's commands.
 */

import { app, Notification } from 'electron';
import os from 'node:os';

import {
  isMenubarSupportedPlatform,
  type MenubarGate,
  type MenubarHelperMessage,
  type MenubarSettingsPatch,
  type MenubarState,
  type MenubarView,
} from '../../shared/menubarQuota.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  focusMainWindow,
  openMainWindowBillingTopUp,
  openMainWindowSession,
  openMainWindowRemoteControlSettings,
  openMainWindowVoiceSettings,
} from '../deepLink.js';
import { getActiveControllers } from '../device-link/dispatch.js';
import { getResolvedMainLocale, rawMainString } from '../i18n.js';
import { createLogger } from '../logger.js';
import { inspectAppDefaultModel } from '../maker-ipc/appDefaultModelControl.js';
import { applyNewMakerDraftRoute } from '../maker-ipc/register.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import { getQuotaOverviewService, type QuotaOverviewBuild, type QuotaOverviewService } from '../quota-overview/service.js';
import { MacMenubarNativeHost } from './MacMenubarNativeHost.js';
import { isLowOnEverything, type MenubarBuildInput } from './snapshot.js';
import { createMenubarTranslate } from './strings.js';
import { buildMenubarActivities } from './activity.js';

const log = createLogger('menubar');

export interface MenubarServiceDeps {
  /** Opens a new task in the main window (the app menu's "New Task" command). */
  openNewTask(): void;
  /** Defaults to the app-wide overview. */
  overview?: QuotaOverviewService;
}

export class MenubarService {
  private readonly host: MacMenubarNativeHost;
  private readonly overview: QuotaOverviewService;
  private started = false;
  private lastView: MenubarView | null = null;
  /** Null until the first build, so launching while low does not notify. */
  private wasLow: boolean | null = null;
  private lowNotification: Notification | null = null;
  private disposers: (() => void)[] = [];

  constructor(private readonly deps: MenubarServiceDeps) {
    this.overview = deps.overview ?? getQuotaOverviewService();
    this.host = new MacMenubarNativeHost({ onMessage: (message) => this.handleHelperMessage(message) });
  }

  get state(): MenubarState {
    return { available: true, enabled: this.overview.settings.enabled };
  }

  init(): void {
    if (this.overview.settings.enabled) this.start();
  }

  setEnabled(enabled: boolean): MenubarState {
    const settings = this.overview.updateSettings({ enabled });
    if (settings.enabled) this.start();
    else this.halt();
    return this.state;
  }

  /** Remote activity updates the icon immediately, independently of usage collection. */
  refreshControlState(): void {
    if (!this.started || !this.lastView || this.lastView.gate) return;
    const control = this.controlState();
    if (
      this.lastView.remotelyControlled === control.remotelyControlled
      && JSON.stringify(this.lastView.remoteControllerNames) === JSON.stringify(control.remoteControllerNames)
    ) return;
    this.lastView = { ...this.lastView, ...control };
    this.host.publish(this.lastView);
  }

  private controlState(gate?: MenubarGate): Pick<MenubarView, 'remotelyControlled' | 'remoteControllerNames'> {
    const controllers = gate ? [] : getActiveControllers();
    return {
      remotelyControlled: controllers.length > 0,
      remoteControllerNames: controllers.map(controller => controller.name),
    };
  }

  /** Opens the panel under the status item. */
  openPanel(): void {
    if (!this.started) return;
    this.host.open();
  }

  stop(): void {
    this.halt();
    this.host.stop();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.wasLow = null;
    this.host.resetFailure();
    this.host.prepare();
    this.disposers.push(this.overview.subscribe((build) => this.publish(build)));
    const island = getAgentIslandService();
    if (island) this.disposers.push(island.subscribeTaskOverview(() => this.publishTaskOverview()));
    // Subscribed first, so the first build after acquiring reaches the helper.
    this.disposers.push(this.overview.acquire());
    const current = this.overview.latest();
    if (current) this.publish(current);
  }

  private halt(): void {
    if (!this.started) return;
    this.started = false;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Listener already gone.
      }
    }
    this.overview.setInteractive(false);
    this.lastView = null;
    this.lowNotification?.close();
    this.lowNotification = null;
    this.host.suspend();
  }

  private publish(build: QuotaOverviewBuild): void {
    const gate = build.view.gate ?? undefined;
    const view: MenubarView = { ...build.view, ...this.taskOverview(gate), ...this.controlState(gate) };
    this.lastView = view;
    this.host.publish(view);
    if (gate) {
      // The first real build after signing in counts as a first build again.
      this.wasLow = null;
      return;
    }
    this.updateLowAlert(isLowOnEverything(build.input), build.input);
  }

  /** Unread changes must not wait for quota/history/network reads to finish. */
  private taskOverview(gate?: MenubarGate): Pick<MenubarView, 'activities' | 'attentionCount'> {
    const locale = getResolvedMainLocale();
    const activities = gate ? [] : buildMenubarActivities(
      getAgentIslandService()?.getTaskOverview() ?? [], this.overview.settings.privacy,
      createMenubarTranslate(locale, key => rawMainString(key, locale)),
    );
    return { activities, attentionCount: activities.filter(row => row.attention).length };
  }

  private publishTaskOverview(): void {
    if (!this.started || !this.lastView || this.lastView.gate || isAppSessionBoundaryPending()) return;
    const overview = this.taskOverview();
    if (JSON.stringify(this.lastView.activities) === JSON.stringify(overview.activities)) return;
    this.lastView = { ...this.lastView, ...overview };
    this.host.publish(this.lastView);
  }

  // ── Low alert ──────────────────────────────────────────────────────────────

  /** Notifies once when everything usable drops to nearly empty; never on the first build. */
  private updateLowAlert(low: boolean, input: MenubarBuildInput): void {
    const previous = this.wasLow;
    this.wasLow = low;
    if (!low) {
      this.lowNotification?.close();
      this.lowNotification = null;
      return;
    }
    if (previous !== false || !this.overview.settings.lowAlert || !getDesktopNotificationsEnabled()) return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: input.t('notify.lowTitle'),
      body: input.t('notify.lowBody'),
    });
    this.lowNotification = notification;
    const release = () => {
      if (this.lowNotification === notification) this.lowNotification = null;
    };
    notification.on('click', () => {
      release();
      this.openPanel();
    });
    notification.on('close', release);
    notification.on('failed', (_event, error) => {
      log.warn('menu bar low alert failed', { error: String(error) });
      release();
    });
    notification.show();
  }

  // ── Helper messages ────────────────────────────────────────────────────────

  private handleHelperMessage(message: MenubarHelperMessage): void {
    switch (message.type) {
      case 'ready':
      case 'error':
        return;
      case 'panel':
        if (this.started) this.overview.setInteractive(message.open);
        return;
      case 'refresh':
        this.overview.refresh(true);
        return;
      case 'open-app':
        this.showMainWindow();
        return;
      case 'open-session':
        if (this.lastView?.activities?.some(row => row.sessionId === message.sessionId)) {
          getAgentIslandService()?.openTaskOverviewSession(message.sessionId);
        } else {
          openMainWindowSession(message.sessionId);
        }
        return;
      case 'detail-action':
        void this.runDetailAction(message.sourceId);
        return;
      case 'open-provider-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'open-remote-control-settings':
        openMainWindowRemoteControlSettings();
        return;
      case 'settings':
        this.applySettingsPatch(message.patch);
        return;
    }
  }

  private applySettingsPatch(patch: MenubarSettingsPatch): void {
    const settings = this.overview.updateSettings(patch);
    if (!settings.enabled) this.halt();
  }

  private showMainWindow(): void {
    if (!focusMainWindow()) app.focus({ steal: true });
  }

  private async runDetailAction(sourceId: string): Promise<void> {
    const action = this.lastView?.details[sourceId]?.action;
    if (!action) return;
    switch (action.kind) {
      case 'new-task':
        await this.openTaskWith(action.providerId);
        return;
      case 'open-billing':
        openMainWindowBillingTopUp();
        return;
      case 'open-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'open-app':
        this.showMainWindow();
        return;
      case 'none':
        return;
    }
  }

  /** New task preselected on this account: the default model when it already uses it. */
  private async openTaskWith(providerId: string): Promise<void> {
    try {
      const { current, available } = await inspectAppDefaultModel();
      const route = current && current.providerId === providerId
        ? current
        : available.find((option) => option.route.providerId === providerId)?.route ?? null;
      if (route) applyNewMakerDraftRoute(route);
      else log.info('no model available for menu bar task', { providerId });
    } catch (error) {
      log.warn('menu bar could not preselect a model', { error: errorMessage(error) });
    }
    this.deps.openNewTask();
  }
}

let service: MenubarService | null = null;

export function initMenubarService(deps: MenubarServiceDeps): void {
  if (service || !isMenubarSupportedPlatform(process.platform, os.release())) return;
  service = new MenubarService(deps);
  service.init();
}

export function getMenubarState(): MenubarState {
  return service?.state ?? { available: false, enabled: false };
}

export function setMenubarEnabled(enabled: boolean): MenubarState {
  return service ? service.setEnabled(enabled) : { available: false, enabled: false };
}

export function refreshMenubarControlState(): void {
  service?.refreshControlState();
}

export function stopMenubarService(): void {
  service?.stop();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
