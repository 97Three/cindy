import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import {
  clearUsageWidgetState,
  readPinnedUsageWidgetDevices,
  readUsageWidgetStore,
  refreshUsageWidgetStore,
  usageWidgetsSupported,
  writeUsageWidgetStore,
} from './usageWidgetSync';

// The computers rebuild their overview every few minutes; the widgets need no more.
const REFRESH_MS = 5 * 60_000;

/**
 * Keeps the iOS home-screen widgets fed while the app is active (renders nothing). Widgets
 * cannot reach a computer themselves, so the app hands them each computer's latest overview.
 */
export function UsageWidgetBridge() {
  const { invoke, readDeviceList, status } = useDeviceLink();
  const { initialized, isAuthenticated, accountGeneration } = useAuth();
  const latest = useRef({ invoke, readDeviceList, accountGeneration });
  latest.current = { invoke, readDeviceList, accountGeneration };

  // Another account (or none) must never see the previous account's quota on the home screen.
  // A cold start of the same account keeps the snapshot, so an offline computer still shows it.
  const seenGeneration = useRef(accountGeneration);
  useEffect(() => {
    if (!usageWidgetsSupported || !initialized) return;
    if (!isAuthenticated || seenGeneration.current !== accountGeneration) clearUsageWidgetState();
    seenGeneration.current = accountGeneration;
  }, [initialized, isAuthenticated, accountGeneration]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !usageWidgetsSupported || !isAuthenticated || status !== 'online') return;
    const generation = accountGeneration;
    let pending = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      if (pending || AppState.currentState !== 'active') return;
      pending = true;
      try {
        const { devices } = await latest.current.readDeviceList();
        const store = await refreshUsageWidgetStore(
          readUsageWidgetStore(), devices, latest.current.invoke, readPinnedUsageWidgetDevices(),
        );
        if (latest.current.accountGeneration === generation) writeUsageWidgetStore(store);
      } catch {
        // Keep the last snapshot; the widgets show how old it is.
      } finally {
        pending = false;
      }
    };
    const resume = () => {
      clearInterval(timer);
      timer = undefined;
      if (AppState.currentState !== 'active') return;
      void refresh();
      timer = setInterval(() => void refresh(), REFRESH_MS);
    };
    resume();
    const subscription = AppState.addEventListener('change', resume);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [isAuthenticated, accountGeneration, status]);

  return null;
}
