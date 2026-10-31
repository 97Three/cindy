// 页面生成手册发布脚本（scripts/publish-page-manual.mjs）的单测。
//
// 测试价值
// - 生产入口与可观察结果：调用 CLI 实际使用的 runPublishPageManual(argv, deps)；断言
//   发布计划里的 OSS key / CDN 地址 / manifest 字节、跳过与报错语义，以及注入的 OSS
//   客户端收到（或没收到）哪些写入。
// - 规则依据：版本化 CDN 路径一经发布不可变（apps/desktop/scripts/ci/lib.mjs 的
//   immutable 守卫约定）；发布入口必须显式指定区域且不跨区兜底
//   （docs/product-rules/region-and-editions.md §2.2、scripts/shared/oss.mjs）。
// - 现有覆盖缺口：新脚本；publish-wallpaper-videos.mjs 与 oss.mjs 均无测试。
// - 最小失败输入：同版本远端已有不同 sha256；--region 与 build-info.region 不一致；
//   本次构建未内置手册。
// - tier：unit。临时目录 + 内存 fake OSS 客户端 / fetch，git 读取与发版机配置注入，
//   不连网、不读凭证。
// - 实测耗时：node --test scripts/__tests__/publish-page-manual.test.mjs 约 0.1 秒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPublishPageManual } from '../publish-page-manual.mjs';
import { PLUGIN_PAGE_MANUAL_SKILL_PATH } from '../../apps/desktop/src/shared/pluginPageManual.mjs';

const COMMIT = 'a'.repeat(40);
const MANUAL = '# Cindy 交互页面生成手册\n\n测试内容\n';
const MANUAL_SHA = createHash('sha256').update(MANUAL).digest('hex');

function fixture({ region = 'global', version = '1.2.3', commitSha = COMMIT, withManual = true } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-page-manual-'));
  if (withManual) {
    const manual = path.join(repoRoot, 'apps/desktop/resources/system-skills', PLUGIN_PAGE_MANUAL_SKILL_PATH);
    fs.mkdirSync(path.dirname(manual), { recursive: true });
    fs.writeFileSync(manual, MANUAL);
  }
  const buildInfo = path.join(repoRoot, 'build-info.json');
  fs.writeFileSync(buildInfo, JSON.stringify({ version, versionless: version === null, region, commitSha }));
  return { repoRoot, buildInfo };
}

function deps(repoRoot, overrides = {}) {
  const logs = [];
  return {
    logs,
    repoRoot,
    env: {},
    log: (line) => logs.push(line),
    git: {
      head: () => COMMIT,
      isPathClean: () => true,
      // 以临时目录模拟「构建 commit 里的文件」。
      readCommittedFile: (root, commit, relative) => {
        assert.equal(commit, COMMIT);
        const file = path.join(root, relative);
        return fs.existsSync(file) ? fs.readFileSync(file) : null;
      },
    },
    applyReleaseConfig: () => {},
    resolveOssConfig: () => { throw new Error('dry-run 不应解析 OSS 发布配置'); },
    createClient: () => { throw new Error('不应创建 OSS 客户端'); },
    fetch: () => { throw new Error('不应访问网络'); },
    ...overrides,
  };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 内存 OSS：objects 预置远端状态；puts 记录写入；put 遵守 x-oss-forbid-overwrite。
function fakeOss(objects = new Map(), { raceOn } = {}) {
  const puts = [];
  return {
    puts,
    objects,
    async head(key) {
      const obj = objects.get(key);
      if (!obj) throw Object.assign(new Error('NoSuchKey'), { status: 404, code: 'NoSuchKey' });
      return { meta: obj.meta ?? {}, res: { headers: {} } };
    },
    async get(key) {
      return { content: objects.get(key).body };
    },
    async put(key, body, options) {
      if (raceOn === key) {
        objects.set(key, { body, meta: { sha256: sha(body) } });
        throw Object.assign(new Error('FileAlreadyExists'), { status: 409, code: 'FileAlreadyExists' });
      }
      if (options?.headers?.['x-oss-forbid-overwrite'] === 'true' && objects.has(key)) {
        throw Object.assign(new Error('FileAlreadyExists'), { status: 409, code: 'FileAlreadyExists' });
      }
      puts.push({ key, body: Buffer.from(body), options });
      objects.set(key, { body: Buffer.from(body), meta: options?.meta });
      return {};
    },
  };
}

// 按 CDN 地址回放 OSS 内容的 fetch；用于发布后的回读校验与 --check-cdn。
function cdnFetch(oss, cdnBase, prefix) {
  return async (url, init) => {
    assert.equal(init.redirect, 'error');
    const key = prefix + url.split('?')[0].slice(cdnBase.length);
    const obj = oss.objects.get(key);
    if (!obj) return new Response('missing', { status: 404 });
    const type = key.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8';
    return new Response(obj.body, { status: 200, headers: { 'content-type': type } });
  };
}

test('dry-run 用 build-info 的版本和区域拼出 key、CDN 地址与 manifest，不连 OSS 也不访问网络', async () => {
  for (const [region, envNames] of [
    ['global', ['XDT_GLOBAL_OSS_PREFIX', 'XDT_GLOBAL_CDN_BASE_URL']],
    ['cn', ['XDT_OSS_PREFIX', 'XDT_CDN_BASE_URL']],
    ['dev', ['XDT_DEVCH_OSS_PREFIX', 'XDT_DEVCH_CDN_BASE_URL']],
  ]) {
    const { repoRoot, buildInfo } = fixture({ region });
    const d = deps(repoRoot, { env: { [envNames[0]]: `pfx-${region}/`, [envNames[1]]: `https://cdn-${region}.test/cindy/` } });
    const result = await runPublishPageManual([`--build-info=${buildInfo}`, `--region=${region}`, '--dry-run'], d);
    assert.equal(result.status, 'dry-run', region);
    assert.deepEqual(result.objects.map((o) => o.key), [
      `pfx-${region}/plugin-pages/manual/1.2.3/PAGE-GENERATION.md`,
      `pfx-${region}/plugin-pages/manual/1.2.3/manifest.json`,
    ]);
    assert.equal(result.objects[0].url, `https://cdn-${region}.test/cindy/plugin-pages/manual/1.2.3/PAGE-GENERATION.md`);
    assert.equal(result.objects[0].sha256, MANUAL_SHA);
    assert.deepEqual(JSON.parse(result.objects[1].body.toString('utf8')), {
      schemaVersion: 1,
      version: '1.2.3',
      sha256: MANUAL_SHA,
      size: Buffer.byteLength(MANUAL),
    });
  }
});

test('本次构建未内置手册时跳过并打印原因，不连 OSS', async () => {
  const { repoRoot, buildInfo } = fixture({ withManual: false });
  const d = deps(repoRoot);
  const result = await runPublishPageManual([`--build-info=${buildInfo}`, '--region=global'], d);
  assert.equal(result.status, 'skipped');
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /跳过.*PAGE-GENERATION\.md/);
});

test('参数、区域与构建一致性不符时拒绝发布', async () => {
  const cases = [
    ['缺少 --region', {}, (b) => [`--build-info=${b}`], /--region/],
    ['非法区域', {}, (b) => [`--build-info=${b}`, '--region=eu'], /--region/],
    ['区域与 build-info 不一致', { region: 'cn' }, (b) => [`--build-info=${b}`, '--region=global'], /build-info\.region/],
    ['无版本构建', { version: null }, (b) => [`--build-info=${b}`, '--region=global'], /版本/],
    ['拼错的 --dryrun 不能落到真实发布', {}, (b) => [`--build-info=${b}`, '--region=global', '--dryrun'], /未知参数/],
    ['同时 --dry-run 与 --check-cdn', {}, (b) => [`--build-info=${b}`, '--region=global', '--dry-run', '--check-cdn'], /不能同时/],
    // 错的 checkout 里没有手册时也必须失败，不能当成「本次构建没有手册」跳过。
    ['checkout 与构建 commit 不一致', { commitSha: 'b'.repeat(40), withManual: false }, (b) => [`--build-info=${b}`, '--region=global'], /commit/],
  ];
  for (const [name, fixtureOptions, argv, error] of cases) {
    const { repoRoot, buildInfo } = fixture(fixtureOptions);
    await assert.rejects(runPublishPageManual(argv(buildInfo), deps(repoRoot)), error, name);
  }
  const { repoRoot, buildInfo } = fixture();
  await assert.rejects(
    runPublishPageManual([`--build-info=${buildInfo}`, '--region=global', '--dry-run'], deps(repoRoot, {
      git: { ...deps(repoRoot).git, isPathClean: () => false },
    })),
    /未提交/,
    '手册有未提交改动',
  );
});

test('发布遵守不可变路径：已存在同指纹复用，不同指纹拒绝覆盖', async () => {
  const prefix = 'cindy';
  const cdnBase = 'https://cdn.test/cindy';
  const mdKey = `${prefix}/plugin-pages/manual/1.2.3/PAGE-GENERATION.md`;
  const manifestKey = `${prefix}/plugin-pages/manual/1.2.3/manifest.json`;
  const other = Buffer.from('# 另一份手册\n');
  const cases = [
    ['远端不存在：先传正文再写 manifest，带禁止覆盖头', new Map(), {}, null, [mdKey, manifestKey]],
    ['远端同指纹：不重复上传', new Map([[mdKey, { body: Buffer.from(MANUAL), meta: { sha256: MANUAL_SHA } }]]), {}, null, [manifestKey]],
    ['远端缺 meta 但内容相同：下载比对后复用', new Map([[mdKey, { body: Buffer.from(MANUAL) }]]), {}, null, [manifestKey]],
    ['并发写入后 409：重新比对同指纹则复用', new Map(), { raceOn: mdKey }, null, [manifestKey]],
    ['远端不同指纹：拒绝覆盖', new Map([[mdKey, { body: other, meta: { sha256: sha(other) } }]]), {}, /不同/, []],
    ['远端缺 meta 且内容不同：拒绝覆盖', new Map([[mdKey, { body: other }]]), {}, /不同/, []],
  ];
  for (const [name, objects, ossOptions, error, expectedPuts] of cases) {
    const { repoRoot, buildInfo } = fixture();
    const oss = fakeOss(objects, ossOptions);
    const d = deps(repoRoot, {
      resolveOssConfig: (region) => {
        assert.equal(region, 'global');
        return { prefix, cdnBase };
      },
      createClient: (region) => {
        assert.equal(region, 'global');
        return oss;
      },
      fetch: cdnFetch(oss, cdnBase, prefix),
    });
    const run = runPublishPageManual([`--build-info=${buildInfo}`, '--region=global'], d);
    if (error) await assert.rejects(run, error, name);
    else assert.equal((await run).status, 'published', name);
    assert.deepEqual(oss.puts.map((p) => p.key), expectedPuts, name);
    for (const put of oss.puts) {
      assert.equal(put.options.headers['x-oss-forbid-overwrite'], 'true', name);
      assert.equal(put.options.headers['Cache-Control'], 'public, max-age=31536000, immutable', name);
      assert.equal(put.options.meta.sha256, sha(put.body), name);
    }
  }
});

test('--check-cdn 只读核对 CDN 上的正文与 manifest', async () => {
  const cdnBase = 'https://cdn.test/cindy';
  const { repoRoot, buildInfo } = fixture();
  const seeded = fakeOss();
  const publishDeps = deps(repoRoot, {
    resolveOssConfig: () => ({ prefix: 'p', cdnBase }),
    createClient: () => seeded,
    fetch: cdnFetch(seeded, cdnBase, 'p'),
  });
  await runPublishPageManual([`--build-info=${buildInfo}`, '--region=global'], publishDeps);

  const env = { XDT_GLOBAL_CDN_BASE_URL: cdnBase };
  const ok = await runPublishPageManual([`--build-info=${buildInfo}`, '--region=global', '--check-cdn'], deps(repoRoot, {
    env,
    fetch: cdnFetch(seeded, cdnBase, 'p'),
  }));
  assert.equal(ok.status, 'verified');

  seeded.objects.set('p/plugin-pages/manual/1.2.3/PAGE-GENERATION.md', { body: Buffer.from('# 被改过\n') });
  await assert.rejects(
    runPublishPageManual([`--build-info=${buildInfo}`, '--region=global', '--check-cdn'], deps(repoRoot, {
      env,
      fetch: cdnFetch(seeded, cdnBase, 'p'),
    })),
    /CDN/,
  );
});
