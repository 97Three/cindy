/** Runs inside unmodified Pi, after every extension payload hook. */
export const PI_CACHE_RECOVERY_SOURCE = String.raw`
function installCindyCacheRecovery(pi) {
  const supported = (api) => api === 'openai-completions' || api === 'openai-responses';
  const fields = ['prompt_cache_key', 'prompt_cache_retention'];
  const day = 24 * 60 * 60 * 1000;
  const home = process.env.CINDY_PI_CACHE_COMPAT_FILE;
  const file = home && home.replace(/^\$HOME(?=\/)/, () => homedir());
  let turn;
  let sequence = 0;
  let memory = Object.create(null);
  let routeRules = new Map();
  function rules() {
    try {
      const name = path.join(process.env.PI_CODING_AGENT_DIR || '', 'pi-cache-compatibility.json');
      if (statSync(name).size > 256 * 1024) return [];
      const value = JSON.parse(readFileSync(name, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }
  function refreshRules() {
    routeRules = new Map(rules().flatMap(rule => {
      if (!rule || typeof rule !== 'object' || typeof rule.providerId !== 'string'
        || !/^[a-f0-9]{64}$/.test(rule.routeKey)) return [];
      return [[JSON.stringify([rule.provider, rule.id, rule.baseUrl, rule.api]),
        JSON.stringify([rule.providerId, rule.id, rule.routeKey])]];
    }));
  }
  refreshRules();
  function route(model) {
    if (!supported(model?.api)) return;
    return routeRules.get(JSON.stringify([model.provider, model.id, model.baseUrl, model.api]));
  }
  function load() {
    if (!file) return { routes: Object.create(null) };
    try {
      const info = statSync(file);
      if (info.size > 256 * 1024) return;
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || !value.routes || typeof value.routes !== 'object' || Array.isArray(value.routes)) return;
      // Stable legacy grace, not a fresh lifetime on every app launch.
      for (const record of Object.values(value.routes)) {
        if (record && record.supportsLongCacheRetention === false && record.expiresAt === undefined
          && record.learnedAt === undefined && record.evidence === undefined) {
          record.learnedAt = info.mtimeMs;
          record.expiresAt = info.mtimeMs + 7 * day;
          record.evidence = 'explicit';
        }
      }
      return value;
    } catch (error) { return error?.code === 'ENOENT' ? { routes: Object.create(null) } : undefined; }
  }
  function active(record, now) {
    return record?.supportsLongCacheRetention === false && Number.isFinite(record.learnedAt) && record.learnedAt <= now
      && Number.isFinite(record.expiresAt) && record.expiresAt > record.learnedAt
      && ['explicit', 'opaque'].includes(record.evidence)
      && record.expiresAt <= record.learnedAt + (record.evidence === 'explicit' ? 7 : 1) * day && record.expiresAt > now;
  }
  function remember(key, evidence, startedAt) {
    const record = { supportsLongCacheRetention: false, evidence, learnedAt: startedAt,
      expiresAt: startedAt + (evidence === 'explicit' ? 7 : 1) * day };
    if ((memory[key]?.learnedAt ?? 0) > startedAt) return;
    memory[key] = record;
    if (!file) return record;
    let temporary;
    try {
      const current = load();
      if (!current || (current.routes[key]?.learnedAt ?? 0) > startedAt) return;
      for (const [otherKey, otherRecord] of Object.entries(current.routes)) {
        if (Number.isFinite(otherRecord?.expiresAt) && otherRecord.expiresAt <= startedAt) delete current.routes[otherKey];
      }
      current.routes[key] = record;
      const data = JSON.stringify(current);
      if (Buffer.byteLength(data) > 256 * 1024) return;
      temporary = file + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
      delete memory[key];
    } catch { /* Storage failure must never undo a successful response. */ }
    finally { if (temporary) { try { rmSync(temporary, { force: true }); } catch {} } }
    return record;
  }
  function withoutCache(payload) {
    const next = { ...payload };
    for (const field of fields) delete next[field];
    return next;
  }
  function fingerprint(payload) {
    return createHash('sha256').update(JSON.stringify(withoutCache(payload), (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
  }
  function requestIdentity(model, options) {
    // Request-only digest stays in memory, including any credential/header state.
    return fingerprint({ api: model?.api, provider: model?.provider, id: model?.id, baseUrl: model?.baseUrl,
      modelHeaders: model?.headers, headers: options?.headers, apiKey: options?.apiKey });
  }
  function rejectedFieldList(text) {
    let rest = text.trimStart().replace(/^\[\s*/, '');
    const result = [];
    while (rest) {
      const match = /^(?:(['"\x60])([a-z_][\w.-]*)\1|([a-z_][\w.-]*))/i.exec(rest);
      if (!match) break;
      const tail = rest.slice(match[0].length);
      // A comma may introduce prose ("use another option instead"). Bare
      // continuation fields must end at a list/sentence boundary; quoted fields
      // are explicit. This parses the list without naming vendors or options.
      if (result.length && !match[1] && !/^\s*(?:[,，;\].!?]|$)/.test(tail)) break;
      result.push((match[2] ?? match[3]).replace(/\.+$/, '').toLowerCase());
      const separator = /^\s*[,，]\s*/.exec(tail);
      if (!separator) break;
      rest = tail.slice(separator[0].length);
    }
    return result;
  }
  function failureKind(message, provider) {
    const text = message?.errorMessage;
    if (typeof text !== 'string' || text.length > 64 * 1024 || message.stopReason !== 'error'
      || message.content?.length || (message.usage?.output ?? 0) > 0) return;
    const prefix = text.startsWith('400:') ? '400:' : provider + ' API error (400):';
    if (!text.startsWith(prefix)) return;
    let body = text.slice(prefix.length).trim();
    let data;
    try { data = JSON.parse(body); } catch { /* Opaque 400 bodies remain eligible. */ }
    for (let depth = 0; data && typeof data === 'object' && depth < 4; depth++) {
      if (data.param != null && !fields.includes(data.param)) return;
      if (data.code === 'UNKNOWN_FIELD' && data.data?.field != null) {
        return fields.includes(data.data.field) ? 'explicit' : undefined;
      }
      if (typeof data.message === 'string') body = data.message;
      // Exclude known unrelated categories; unfamiliar gateway types stay opaque.
      if ([data.code, data.type].some(value => typeof value === 'string'
        && /auth|permission|forbidden|quota|billing|rate.?limit|model.?not.?found|context|length|content.?filter|policy|invalid.?value/i.test(value))) return;
      data = data.error;
    }
    if (/api.?key|unauthori[sz]ed|authentication|permission denied|quota|rate.?limit|model.{0,30}(?:not found|does not exist)|context.{0,25}(?:length|limit)|content.?filter|content.?policy|invalid.{0,15}value|鉴权|认证失败|额度|限流|模型不存在|上下文.{0,8}(?:超|长)|内容审核|参数值/i.test(body)) return;
    // A named rejection is evidence even when a gateway omits structured param.
    // Parse the field relationship, never a list of vendor or parameter names.
    let cacheRejected = false;
    for (const pattern of [
      /(?:unsupported|unknown|unrecognized|unexpected)\s+(?:parameters?|fields?|arguments?|properties|property|options?)(?:\(s\))?[\s:=]*/gi,
      /(?:parameter|field|argument|property|option)\s*[:=]?\s*['"\x60]?([a-z_][\w.-]*)['"\x60]?\s+(?:is\s+)?(?:unsupported|unknown|unrecognized|unexpected|not\s+(?:supported|allowed|permitted))/gi,
      /(?:未知|不支持|不接受|无法识别)(?:的)?(?:请求)?(?:参数|字段|属性|选项)[\s:：=]*/gi,
      /(?:参数|字段|属性|选项)\s*[:：=]?\s*['"\x60]?([a-z_][\w.-]*)['"\x60]?\s*(?:不支持|不被支持|未知|无法识别)/gi,
    ]) {
      for (const match of body.matchAll(pattern)) {
        const rejected = match[1] ? [match[1].replace(/\.+$/, '').toLowerCase()]
          : rejectedFieldList(body.slice(match.index + match[0].length));
        for (const field of rejected) {
          if (!fields.includes(field)) return;
          cacheRejected = true;
        }
      }
    }
    return cacheRejected || /(?:unsupported|not supported|unknown|未知|不支持).{0,80}prompt_cache_(?:key|retention)|prompt_cache_(?:key|retention).{0,80}(?:unsupported|not supported|unknown|未知|不支持)/i.test(body) ? 'explicit' : 'opaque';
  }
  pi.on('input', () => {
    // Queuing/steering invalidates the old trial immediately. It cannot arm a
    // budget for the new input until Pi actually starts that user message.
    if (turn) { turn.safe = false; turn.valid = false; }
  });
  pi.on('message_start', (event) => {
    if (event.message?.role !== 'user') return;
    // Queued follow-ups do not emit agent_start. Tool continuations and native
    // retries do not start a user message, so they retain this input's budget.
    refreshRules();
    const records = load()?.routes ?? Object.create(null);
    for (const [key, record] of Object.entries(memory)) {
      if ((records[key]?.learnedAt ?? 0) < record.learnedAt) records[key] = record;
    }
    const startedAt = Date.now();
    const learned = new Set(Object.keys(records).filter(key => active(records[key], startedAt)));
    turn = { sequence: ++sequence, safe: true, valid: true, attempted: false, learned };
  });
  for (const name of ['tool_call', 'tool_execution_start', 'model_select', 'session_switch', 'session_shutdown']) {
    pi.on(name, () => { if (turn) { turn.safe = false; turn.valid = false; } });
  }
  pi.on('before_provider_request', (event, ctx) => {
    // Older registries cannot safely restore an extension provider's ownership.
    // Keep their existing host recovery usable without registering a provider;
    // modern registries leave all payload handling to the final stream wrapper.
    if (typeof ctx.modelRegistry?.getProvider === 'function'
      && typeof ctx.modelRegistry?.getRegisteredNativeProvider === 'function') return;
    const key = route(ctx.model);
    // Use the same input snapshot as the modern wrapper, including tool rounds
    // across expiry. Before any input exists, preserve native preparation calls.
    if (!key || !(turn ? turn.learned.has(key) : active(load()?.routes[key], Date.now()))) return;
    const payload = event.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) return withoutCache(payload);
  });
  return {
    refreshRules,
    accepts: model => Boolean(route(model)),
    wrap(model, options, invoke, provider = model.provider) {
      const key = route(model);
      if (!key || !turn) return invoke(options);
      const owner = turn;
      const startedAt = Date.now();
      const learned = owner.learned.has(key);
      let originalFingerprint;
      let originalIdentity;
      let hasCache = false;
      let skipped = false;
      const sameInput = () => turn === owner && owner.valid && owner.safe && !options?.signal?.aborted;
      const requestOptions = (trial) => ({ ...options,
        onPayload: async (payload, requestModel) => {
          const replacement = await options?.onPayload?.(payload, requestModel);
          const finalPayload = replacement === undefined ? payload : replacement;
          if (!finalPayload || typeof finalPayload !== 'object' || Array.isArray(finalPayload)) return finalPayload;
          if (trial) {
            if (!sameInput() || fingerprint(finalPayload) !== originalFingerprint
              || requestIdentity(requestModel, options) !== originalIdentity) {
              skipped = true;
              throw new Error('CINDY_CACHE_RETRY_CONTEXT_CHANGED');
            }
            return withoutCache(finalPayload);
          }
          hasCache = fields.some(field => Object.hasOwn(finalPayload, field));
          if (hasCache && sameInput() && !owner.attempted && requestModel?.id === model.id
            && requestModel?.api === model.api && requestModel?.baseUrl === model.baseUrl) {
            originalFingerprint = fingerprint(finalPayload);
            originalIdentity = requestIdentity(requestModel, options);
          }
          return learned || owner.trialKey === key ? withoutCache(finalPayload) : finalPayload;
        },
      });
      return (async function* () {
        for await (const event of invoke(requestOptions(false))) {
          if (event.type !== 'error') {
            // A successful response start rules out retrying an in-stream failure.
            owner.safe = false;
            yield event;
            continue;
          }
          const evidence = failureKind(event.error, provider);
          if (!evidence || learned || !hasCache || !originalFingerprint || !sameInput() || owner.attempted) {
            yield { ...event, error: { ...event.error, cindyCacheRecoveryHandled: true } };
            continue;
          }
          owner.attempted = true;
          owner.trialKey = key;
          for await (const retried of invoke(requestOptions(true))) {
            if (skipped) {
              yield options?.signal?.aborted ? retried : { ...event, error: { ...event.error, cindyCacheRecoveryHandled: true } };
              return;
            }
            if (retried.type === 'done' && turn === owner && owner.valid && !options?.signal?.aborted
              && ['stop', 'toolUse'].includes(retried.message?.stopReason)) {
              const record = remember(key, evidence, startedAt);
              if (record) owner.learned.add(key);
            }
            if (retried.type !== 'error') owner.safe = false;
            yield retried.type === 'error'
              ? { ...retried, error: { ...retried.error, cindyCacheRecoveryHandled: true } } : retried;
          }
          return;
        }
      })();
    },
  };
}
`;
