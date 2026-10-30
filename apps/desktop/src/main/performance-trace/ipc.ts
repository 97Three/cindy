import type { IpcMainInvokeEvent } from 'electron';
import { isIpcError } from '../../shared/ipc-errors';
import { throwIpcError } from '../utils/ipcValidate';
import type { PerformanceTraceController } from './controller';

export function createTraceCommandHandler(deps: {
  controller: PerformanceTraceController;
  authorize(event: IpcMainInvokeEvent): void;
  isSource(event: IpcMainInvokeEvent): boolean;
  isSourceDestroyed(): boolean;
  isMainWindow(event: IpcMainInvokeEvent): boolean;
  selectSource(event: IpcMainInvokeEvent): void;
  showFolder(): Promise<void>;
}) {
  return async (event: IpcMainInvokeEvent, command: unknown, note: unknown) => {
    deps.authorize(event);
    if (
      typeof command !== 'string' ||
      !['state', 'start', 'stop', 'show-local', 'upload'].includes(command)
    )
      throwIpcError('INVALID_PARAMS', 'Invalid trace command');
    if (note !== undefined && (typeof note !== 'string' || note.length > 1000))
      throwIpcError('INVALID_PARAMS', 'Invalid trace note');
    const controller = deps.controller;
    try {
      // A completed report belongs to the account, not to a destroyed renderer.
      // snapshot() hides reports from invalidated owners; active captures stay source-bound.
      if (
        command !== 'start' &&
        controller.snapshot().phase === 'ready' &&
        !deps.isSource(event) &&
        deps.isSourceDestroyed() &&
        deps.isMainWindow(event)
      )
        deps.selectSource(event);
      if (command === 'state') return controller.snapshot();
      if (command === 'show-local' && controller.snapshot().phase === 'idle') {
        await deps.showFolder();
        return controller.snapshot();
      }
      if (command !== 'start' && !deps.isSource(event))
        throwIpcError('PRECONDITION_FAILED', 'Use the window that started this recording');
      if (command === 'start') {
        if (!controller.canStart()) throwIpcError('PRECONDITION_FAILED', 'Recording is busy');
        deps.selectSource(event);
        return await controller.start();
      }
      if (command === 'stop') return await controller.stop();
      if (command === 'show-local') return await controller.reveal();
      return await controller.upload(typeof note === 'string' ? note : '');
    } catch (error) {
      if (
        isIpcError(error) &&
        [
          'PRECONDITION_FAILED',
          'LOG_UPLOAD_FAILED',
          'LOG_UPLOAD_UNAVAILABLE',
          'PRIVACY_CONSENT_REQUIRED',
        ].includes(error.code)
      )
        throw error;
      throwIpcError(
        'INTERNAL',
        'Performance recording operation failed; retry or keep the local report',
      );
    }
  };
}
