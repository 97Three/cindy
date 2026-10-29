import { approvedNodeCredentialManifest, nodeCredentialSettingsMethod, type InstalledGhost } from '../../../shared/ghost.js';
import type { GhostNodeRuntimeBroker } from '../nodeRuntimeBroker.js';

interface Dependencies {
  ghost(id: string): InstalledGhost | null;
  broker(): Pick<GhostNodeRuntimeBroker, 'handleRequest'>;
}
const headers = { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' };

/** A single fetch owns the authorization lifetime. No Session, generic IPC, or stored URL. */
export async function nodeSettingsAuthorization(
  deps: Dependencies, id: string, request: Request, current: () => boolean, dispose: () => void = () => {},
): Promise<Response> {
  const url = new URL(request.url);
  const key = /^\/node-authorization\/([a-z][a-z0-9_]{0,31})$/.exec(url.pathname)?.[1];
  const ghost = deps.ghost(id);
  const binding = ghost?.enabled && approvedNodeCredentialManifest(ghost).node?.secretBindings?.find(b => b.key === key);
  if (!key || !binding || !nodeCredentialSettingsMethod(binding) ||
      binding.oauthSecret || !current() || url.search) return new Response(null, { status: 403 });
  if (request.method === 'GET') return Response.json({ available: true });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  let params: unknown;
  try {
    // Same bounded reader as the other plugin settings endpoints.
    const { readBoundedBodyText } = await import('./ghostKvEndpoint.js');
    const body = await readBoundedBodyText(request);
    if (body.length > 4096) return new Response(null, { status: 413 });
    params = JSON.parse(body || '{}');
    if (!params || typeof params !== 'object' || Array.isArray(params)) return new Response(null, { status: 400 });
  } catch { return new Response(null, { status: 400 }); }
  if (!current() || request.signal.aborted) return new Response(null, { status: 403 });
  const control = new AbortController();
  const abort = () => control.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const snapshot = JSON.stringify(ghost.manifest);
  const assertCurrent = () => {
    const active = deps.ghost(id);
    if (control.signal.aborted || !current() || !active?.enabled || active.nodeCredentialCapabilityApproved !== true || active.dir !== ghost.dir ||
        JSON.stringify(active.manifest) !== snapshot) throw new Error('PAGE_AUTHORIZATION_UNAVAILABLE');
  };
  let timer: ReturnType<typeof setTimeout>;
  let guard: ReturnType<typeof setInterval>;
  const cleanup = () => { dispose(); clearTimeout(timer); clearInterval(guard); request.signal.removeEventListener('abort', abort); };
  let identity: string | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        if (!closed) controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
      };
      const finish = () => { if (!closed) { closed = true; controller.close(); } cleanup(); control.abort(); };
      timer = setTimeout(abort, 300_000); timer.unref?.();
      guard = setInterval(() => { try { assertCurrent(); } catch { abort(); } }, 1000); guard.unref?.();
      void deps.broker().handleRequest(id, {
        type: 'node-request', method: binding.settingsMethod, params,
        ...(binding.entry ? { entry: binding.entry } : {}), timeoutMs: 120_000, maxTotalMs: 300_000,
      }, {
        key, signal: control.signal, assertCurrent,
        ready(value) { assertCurrent(); send({ state: 'authorize', ...value }); },
        saved(value) { assertCurrent(); identity = value; },
      }).then(result => {
        assertCurrent();
        // Never forward the worker result/error payload into a settings document.
        send(result.ok && identity ? { state: 'saved', identity } : { state: 'failed' });
      }).catch(() => { if (!control.signal.aborted) send({ state: 'failed' }); })
        .finally(finish);
    },
    cancel() { closed = true; cleanup(); control.abort(); },
  });
  return new Response(stream, { headers });
}
