// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ owner: 'owner:1:global', current: true, companionRoom: vi.fn(), history: vi.fn(), media: vi.fn(), disk: new Map<string, string>() }));
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (key: string) => h.disk.get(key) ?? null,
  write: async (key: string, value: string) => { h.disk.set(key, value); },
  remove: async (key: string) => { h.disk.delete(key); }, files: async () => [...h.disk.keys()],
}) }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-crypto', () => ({ digestStringAsync: vi.fn(async () => 'hash'), CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, CryptoEncoding: { HEX: 'hex' } }));
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
vi.mock('@/chat/useChatServer', async () => {
  const { useMemo } = await import('react');
  return { useChatClient: () => useMemo(() => ({ owner: h.owner, enabled: true, current: () => h.current,
    client: { companionRoom: h.companionRoom, history: h.history, media: h.media } }), [h.owner]) };
});
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { peekCloudConversation } from '@/chat/cloudConversationCache';
import { useCloudCompanionRoom } from '@/chat/useCloudCompanionRoom';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ROOM = '00000000-0000-4000-8000-0000000000aa';
const MEDIA = '00000000-0000-4000-8000-0000000000bb';
let root: Root;
let result: ReturnType<typeof useCloudCompanionRoom>;
function Probe() { result = useCloudCompanionRoom('actor', 'Writer', true); return null; }
const render = () => act(async () => root.render(createElement(Probe)));
beforeEach(async () => {
  setMobileAuthOwner(null); peekCloudConversation('actor'); await clearHistoryDisk(); setMobileAuthOwner('owner');
  vi.resetAllMocks(); h.owner = 'owner:1:global'; h.current = true;
  h.companionRoom.mockResolvedValue(ROOM); h.history.mockResolvedValue({ messages: [], before: null });
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

// Tier: behavior. An attachment address is signed per room, so it must be asked of the room this
// hook resolved, and an answer that arrives after the account changed must not be shown.
it('fetches an attachment address from the 1:1 room and drops it when the account changed meanwhile', async () => {
  const file = { id: MEDIA, name: 'report.docx', mimeType: 'application/msword', size: 3, category: 'file', url: 'https://files.example/r', path: null };
  h.media.mockResolvedValue(file);
  await render();
  await expect(result.media(MEDIA)).resolves.toBe(file);
  expect(h.media).toHaveBeenCalledWith(ROOM, MEDIA);
  let complete!: (value: unknown) => void;
  h.media.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const late = result.media(MEDIA);
  h.current = false;
  complete(file);
  await expect(late).rejects.toThrow('OWNER_CHANGED');
});

it('has no address to fetch before the room is known', async () => {
  h.companionRoom.mockReturnValue(new Promise(() => {}));
  await render();
  await expect(result.media(MEDIA)).rejects.toThrow('OWNER_CHANGED');
  expect(h.media).not.toHaveBeenCalled();
});

// Integration: the cloud-only route must hydrate before resolving the companion room.
// Existing coverage tested signed attachment access but never reopened this route offline.
it('restores a saved cloud transcript across remount and process-cache loss, then purges revoked access', async () => {
  const message = { id: 'message', seq: '1', authorId: 'actor', author: { name: 'Writer', kind: 'bot' }, content: [{ type: 'text', text: 'Saved reply' }] };
  h.history.mockResolvedValue({ messages: [message], before: null });
  await render(); expect(result.messages).toEqual([message]);
  await act(async () => root.unmount());
  setMobileAuthOwner(null); peekCloudConversation('actor'); setMobileAuthOwner('owner');
  h.companionRoom.mockImplementation(() => new Promise(() => {}));
  root = createRoot(document.createElement('div')); await render();
  expect(result.status).toBe('ready'); expect(result.messages).toEqual([message]);
  h.history.mockRejectedValue({ status: 403 });
  await act(async () => result.reload());
  expect(result.messages).toEqual([]); expect(peekCloudConversation('actor')).toBeNull();
});
