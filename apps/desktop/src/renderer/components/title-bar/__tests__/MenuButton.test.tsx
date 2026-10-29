// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/checkForUpdateWithToast', () => ({
  checkForUpdateWithToast: vi.fn(),
}));

import { MenuButton } from '@/components/title-bar/MenuButton';
import { PerformanceTrace } from '@/components/performance-trace/PerformanceTrace';
vi.mock('@/features/device-link/useSharedTaskTasks', () => ({ useSharedTaskTasks: vi.fn() }));
vi.mock('@/features/device-link/JoinSharedTaskDialog', () => ({
  JoinSharedTaskDialog: () => null,
}));
vi.mock('@/features/device-link/SharedTaskEndedNotice', () => ({
  SharedTaskEndedNotice: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('MenuButton tooltip and dropdown interaction', () => {
  // Unit: the new menu must transfer focus/control to the real recording dialog.
  // The standalone recording fixture cannot catch dropdown dismissal swallowing its open action.
  it('opens performance tracing from the menu and starts recording after the menu closes', async () => {
    const initial = {
      phase: 'idle',
      startedAt: null,
      reportId: null,
      uploaded: false,
      partial: false,
      durationMs: 0,
    };
    const command = vi.fn(async (action: string) =>
      action === 'start'
        ? { ...initial, phase: 'recording', startedAt: Date.now(), reportId: 'ABCD-EFGH' }
        : initial,
    );
    vi.stubGlobal('electronAPI', {
      performanceTrace: { command, events: vi.fn(), onState: () => () => {} },
    });
    const user = userEvent.setup();
    render(
      <>
        <MenuButton />
        <PerformanceTrace />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'titleBar.menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'performanceTrace.title' }));
    expect(await screen.findByRole('alertdialog', { name: 'performanceTrace.title' })).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'performanceTrace.start' }));
    expect(await screen.findByRole('button', { name: 'performanceTrace.stop' })).toBeTruthy();
    expect(command).toHaveBeenCalledWith('start', undefined);
  });
  it('dismisses the tooltip when the menu opens', async () => {
    const user = userEvent.setup();
    render(<MenuButton />);

    const trigger = screen.getByRole('button', { name: 'titleBar.menu' });
    await user.hover(trigger);

    expect((await screen.findByRole('tooltip')).textContent).toContain('titleBar.menu');

    await user.click(trigger);

    expect(screen.getByRole('menu')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});
