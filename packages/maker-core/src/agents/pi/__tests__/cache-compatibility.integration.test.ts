import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
const binary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../apps/pi-bin', process.platform + '-' + process.arch, process.platform === 'win32' ? 'pi.exe' : 'pi');
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
function responses() {
  const item = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [], logprobs: [] }] };
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map((event, sequence_number) => 'event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n').join('');
}

// Integration tier: public PiAgent -> generated bridge -> official Pi -> loopback
// HTTP, covering #5878/#6570/#6649, both adapters, one transcript input and TTL.
describe.skipIf(!existsSync(binary))('Pi cache recovery over real native RPC/HTTP', () => {
  it.each(['openai-completions', 'openai-responses'].flatMap(api => [
    { api, mode: 'opaque', rejection: { error: { message: 'opaque refusal', type: 'invalid_request_error', param: null } } },
    { api, mode: 'explicit', rejection: { message: '未知请求字段：prompt_cache_retention', type: 'invalid_request_error' } },
    { api, mode: 'always-fails', rejection: { message: 'Validation: Unsupported parameter(s): prompt_cache_key', type: 'invalid_request_error' } },
    { api, mode: 'supported', rejection: {} },
  ]))('preserves bounded recovery and native caching: $api / $mode', async ({ api, mode, rejection }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-cache-integration-'));
    const received: Array<Record<string, unknown>> = [];
    let rejectCache = mode !== 'supported';
    let persistentFailure = mode === 'always-fails';
    const gateway = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer fixture-key');
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); received.push(data);
      if (persistentFailure || rejectCache && ('prompt_cache_key' in data || 'prompt_cache_retention' in data)) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(rejection)); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(api === 'openai-responses' ? responses() : 'data: ' + JSON.stringify({ id: 'one', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ id: 'one', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n' + 'data: [DONE]\n\n');
    });
    let handle: AgentSessionHandle | undefined;
    try {
      await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
      const address = gateway.address(); if (!address || typeof address === 'string') throw new Error('missing loopback listener');
      let endpoint = 'http://127.0.0.1:' + address.port + '/api.openai.com/v1';
      const storeFile = path.join(root, 'compat.json');
      const deps: AgentDeps = {
        binaryPath: binary, logger,
        auth: { getState: async () => ({ authenticated: true, identity: 'fixture', authSource: 'api-key' }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {}, getAuthEnv: async () => ({}) },
        runtimeConfig: { endpoint: 'http://127.0.0.1:0' },
        resolvePiAgentHome: () => path.join(root, 'agent'),
        resolvePiNativeCompatStorePath: () => storeFile,
        resolvePiNativeProviders: async () => ({ providers: [{ id: 'strict', sourceProviderId: 'strict', name: 'Strict fixture', apiKeyEnvVar: 'CINDY_PI_KEY_FIXTURE', baseUrl: endpoint, api: api as 'openai-completions' | 'openai-responses', modelIdAliases: { 'fixture-alias': 'fixture-public' }, models: [{ id: 'fixture-public', wireId: 'fixture', api: api as 'openai-completions' | 'openai-responses', contextWindow: 32768, maxTokens: 100 }] }], env: { CINDY_PI_KEY_FIXTURE: 'fixture-key' } }),
        preparePiExtraSpawnConfig: async () => ({ mcpEnv: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'xdg') } }),
      };
      const workingDir = path.join(root, 'work'); mkdirSync(workingDir);
      const opts = { workingDir, model: 'fixture-alias', providerId: 'strict', permissionMode: 'bypassPermissions' as const };
      const run = async () => {
        const events: AgentEvent[] = [];
        const finish = (async () => { for await (const event of handle!.events()) { events.push(event); if (event.type === 'done') break; } })();
        await handle!.send({ type: 'user', content: 'Reply OK' }); await finish; return events;
      };
      const agent = new PiAgent(deps);
      handle = await agent.startSession({ ...opts, sessionId: 'first' });
      const first = await run();
      expect(received).toHaveLength(mode === 'supported' ? 1 : 2);
      expect(received[0]).toHaveProperty('prompt_cache_key');
      expect(received[0]).toHaveProperty('prompt_cache_retention', '24h');
      if (mode !== 'supported') {
        const { prompt_cache_key: _key, prompt_cache_retention: _retention, ...without } = received[0];
        expect(received[1]).toEqual(without);
      }
      expect(first.filter(e => e.type === 'done')).toHaveLength(1);
      const sessions = path.join(root, 'agent', 'sessions');
      const transcripts = readdirSync(sessions, { recursive: true }).map(name => path.join(sessions, name.toString())).filter(name => name.endsWith('.jsonl'));
      const entries = transcripts.flatMap(name => readFileSync(name, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
      expect(entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user')).toHaveLength(1);
      expect(entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant')).toHaveLength(1);
      if (mode === 'always-fails') {
        expect(first.filter(e => e.type === 'error')).toHaveLength(1);
        expect(first.find(e => e.type === 'error')?.data).toMatchObject({ piCacheRecoveryHandled: true });
        expect(existsSync(storeFile)).toBe(false);
        persistentFailure = false; rejectCache = false;
        await run(); expect(received).toHaveLength(3);
        expect(received[2]).toHaveProperty('prompt_cache_key');
        return;
      }
      expect(first.some(e => e.type === 'error')).toBe(false);
      expect(first.find(e => e.type === 'done')?.data).toMatchObject({ result: 'OK' });
      if (mode === 'supported') { expect(existsSync(storeFile)).toBe(false); return; }
      const store = JSON.parse(readFileSync(storeFile, 'utf8'));
      const records = Object.values(store.routes) as Array<{ learnedAt: number; expiresAt: number; evidence: string }>;
      expect(records).toHaveLength(1);
      expect(records[0].expiresAt - records[0].learnedAt).toBe((mode === 'explicit' ? 7 : 1) * 86400000);
      expect(readFileSync(storeFile, 'utf8')).not.toContain(endpoint);
      await handle.close(); handle = await agent.startSession({ ...opts, sessionId: 'learned' });
      await run(); expect(received).toHaveLength(3); expect(received[2]).not.toHaveProperty('prompt_cache_key');
      // The same running Pi must restore real fields when its rule expires.
      records[0].expiresAt = Date.now() - 1;
      writeFileSync(storeFile, JSON.stringify(store)); rejectCache = false;
      await run(); expect(received).toHaveLength(4); expect(received[3]).toHaveProperty('prompt_cache_key');
      await handle.close(); endpoint += '/other';
      handle = await agent.startSession({ ...opts, sessionId: 'other-route' });
      await run(); expect(received[4]).toHaveProperty('prompt_cache_retention', '24h');
    } finally {
      await handle?.close(); gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
