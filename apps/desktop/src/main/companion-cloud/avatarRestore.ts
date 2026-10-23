/**
 * Turn a cloud companion avatar into something a local profile can store.
 *
 * A download that will never succeed must not keep the take-over demoted: other
 * devices would keep opening a task this computer cannot run. A failure that may
 * still succeed leaves the copy demoted for the next automatic attempt.
 */
import { BOT_AVATAR_MAX_BYTES, portableBotAvatarOrFallback } from '../../shared/botAvatarValue.js';
import { fetchPublicImageBytes } from '../im/publicImageFetch.js';
import { validateBotAvatarBuffer } from '../localDb/ipc/botAvatarSelection.js';
import { isUnreachable } from './types.js';

const AVATAR_FETCH_TIMEOUT_MS = 15_000;

export type RestoredCloudAvatar = { portable: string } | { imageBase64: string };

/** Network, timeout and temporary server failures can still yield the image. A refused or invalid file cannot. */
export function avatarDownloadMaySucceedLater(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (isUnreachable(error)) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'OWNER_CHANGED') return true;
  const status = Number(/^remote image request failed: HTTP (\d+)$/.exec(error.message)?.[1]);
  return status >= 500 || status === 408 || status === 429;
}

export async function restoreCloudAvatar(avatar: string | null, signal?: AbortSignal): Promise<RestoredCloudAvatar> {
  if (!avatar?.startsWith('https://')) return { portable: portableBotAvatarOrFallback(avatar) };
  try {
    const { buffer } = await fetchPublicImageBytes(avatar, BOT_AVATAR_MAX_BYTES, undefined, { signal, timeoutMs: AVATAR_FETCH_TIMEOUT_MS });
    validateBotAvatarBuffer(Buffer.from(buffer));
    return { imageBase64: Buffer.from(buffer).toString('base64') };
  } catch (error) {
    if (avatarDownloadMaySucceedLater(error, signal)) throw new Error('AVATAR_UNAVAILABLE');
    return { portable: portableBotAvatarOrFallback(null) };
  }
}
