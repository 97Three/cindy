#!/usr/bin/env node
// =============================================================================
// publish-page-manual.mjs — 把本次构建内置的《页面生成手册》发布到版本化 CDN 路径
//
// 业务后端里生成交互页面的 LLM 需要读 PAGE-GENERATION.md。手册随客户端内置 Skill
// 发版，这里把同一份字节按发版版本号上传，供后端按客户端版本取用：
//   {cdnBaseUrl}/plugin-pages/manual/{version}/PAGE-GENERATION.md
//   {cdnBaseUrl}/plugin-pages/manual/{version}/manifest.json   {schemaVersion, version, sha256, size}
// 路径约定见 apps/desktop/src/shared/pluginPageManual.mjs（运行时复用同一份）。
//
// 由外部发布套件在「上传安装包之后、发布 canary update manifest 之前」按同一区域调用：
//   node scripts/publish-page-manual.mjs \
//     --build-info=release/artifacts/<region>/<version>/<platform-arch>/build-info.json \
//     --region=<region>
// mac 双架构会各调一次；同版本同内容直接复用，脚本幂等。
//
//   --build-info=<path>   package-desktop.mjs 产出的 build-info.json；版本号、区域、commit 都从这里取
//   --region=cn|global|dev 必填，且必须与 build-info.region 一致（发布入口不设默认区域）
//   --dry-run             只打印要上传什么，不连 OSS、不访问网络
//   --check-cdn           只读核对 CDN 上已发布的内容，不连 OSS
//
// 手册字节取自构建 commit（Forge extraResource 原样打包该文件），并要求发布机 checkout
// 正是构建 commit、该文件没有未提交改动。构建 commit 里没有手册时跳过、退出码 0。
// 版本化路径一经发布不可变：同版本远端已有不同内容时失败，不覆盖。
// 发布目标（CDN 基址 / bucket / prefix）与其它 desktop 发布脚本一样取自环境变量，缺失时
// 由发版机的 release-regions.json 补齐；凭证只在真正上传时由 scripts/shared/oss.mjs 从
// 进程环境变量读取。本脚本不加载 .env。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  OSS_ENV_NAMES_BY_REGION,
  RELEASE_REGIONS,
  createOSSClient,
  resolveOssConfig,
} from './shared/oss.mjs';
import {
  applyReleaseCdnBaseUrlToEnv,
  applyReleaseRegionConfigToEnv,
} from '../apps/desktop/scripts/ci/release-regions.mjs';
import {
  PLUGIN_PAGE_MANUAL_MANIFEST_SCHEMA_VERSION,
  PLUGIN_PAGE_MANUAL_SKILL_PATH,
  pluginPageManualCdnPath,
  pluginPageManualManifestCdnPath,
} from '../apps/desktop/src/shared/pluginPageManual.mjs';

const USAGE =
  'Usage: node scripts/publish-page-manual.mjs --build-info=<build-info.json> --region=cn|global|dev [--dry-run | --check-cdn]';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANUAL_REPO_PATH = `apps/desktop/resources/system-skills/${PLUGIN_PAGE_MANUAL_SKILL_PATH}`;
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const joinUrl = (base, relative) => `${base.replace(/\/+$/, '')}/${relative}`;

export function parsePublishPageManualArgs(argv) {
  let buildInfoPath;
  let region;
  let dryRun = false;
  let checkCdn = false;
  for (const arg of argv) {
    if (arg.startsWith('--build-info=')) buildInfoPath = arg.slice('--build-info='.length);
    else if (arg.startsWith('--region=')) region = arg.slice('--region='.length);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--check-cdn') checkCdn = true;
    // 拼错的模式参数不能静默落到真实上传。
    else throw new Error(`未知参数: ${arg}\n${USAGE}`);
  }
  if (!RELEASE_REGIONS.includes(region)) {
    throw new Error(`必须显式指定 --region=cn|global|dev\n${USAGE}`);
  }
  if (!buildInfoPath) throw new Error(`缺少 --build-info\n${USAGE}`);
  if (dryRun && checkCdn) throw new Error(`--dry-run 与 --check-cdn 不能同时使用\n${USAGE}`);
  return { buildInfoPath, region, mode: dryRun ? 'dry-run' : checkCdn ? 'check-cdn' : 'publish' };
}

function defaultDeps() {
  return {
    repoRoot: REPO_ROOT,
    env: process.env,
    log: (line) => console.log(line),
    git: {
      head: (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      // 未跟踪、已修改、已暂存都算不干净：Forge 打包的是工作区字节，必须与提交一致。
      isPathClean: (root, relative) =>
        execFileSync('git', ['status', '--porcelain', '--', relative], { cwd: root, encoding: 'utf8' }).trim() === '',
      // 从提交对象读取；提交里没有该路径（含被 .gitignore 的本地文件）时返回 null。
      readCommittedFile: (root, commit, relative) => {
        try {
          execFileSync('git', ['cat-file', '-e', `${commit}:${relative}`], { cwd: root, stdio: 'ignore' });
        } catch {
          return null;
        }
        return execFileSync('git', ['cat-file', 'blob', `${commit}:${relative}`], { cwd: root });
      },
    },
    // 与其它 desktop 发布脚本一致：env 显式值优先，缺失的发布目标由 release-regions.json 补齐。
    applyReleaseConfig: (region, mode) => {
      if (mode === 'publish') {
        applyReleaseRegionConfigToEnv(region);
        return;
      }
      try {
        if (mode === 'check-cdn') applyReleaseCdnBaseUrlToEnv(region);
        else applyReleaseRegionConfigToEnv(region);
      } catch {
        // 只读模式不要求发版机配置齐全：dry-run 打印占位，check-cdn 由 readReleaseTarget 报缺哪个变量。
      }
    },
    resolveOssConfig,
    createClient: createOSSClient,
    fetch: (...args) => globalThis.fetch(...args),
  };
}

function readReleaseTarget(deps, region, key, { required }) {
  const envName = OSS_ENV_NAMES_BY_REGION[region][key];
  const value = deps.env[envName]?.trim();
  if (value) return value;
  if (!required) return `<${envName}>`;
  throw new Error(`找不到 ${region} 区发布目标：请设置 ${envName} 或在 release-regions.json 中填写`);
}

async function remoteSha256(client, key) {
  let res;
  try {
    res = await client.head(key);
  } catch (err) {
    const status = err?.status ?? err?.res?.status;
    if (status === 404 || err?.code === 'NoSuchKey') return null;
    throw err;
  }
  const recorded = res?.meta?.sha256 ?? res?.res?.headers?.['x-oss-meta-sha256'];
  if (recorded) return recorded;
  // 没有 sha256 meta 的对象（例如手工上传）下载回来比对，不凭缺失信息放行覆盖。
  const { content } = await client.get(key);
  return sha256(content);
}

async function putImmutable(client, object, log) {
  let existing = await remoteSha256(client, object.key);
  if (existing === null) {
    try {
      await client.put(object.key, object.body, {
        headers: {
          'Content-Type': object.contentType,
          'Cache-Control': IMMUTABLE_CACHE_CONTROL,
          // 由 OSS 原子拒绝覆盖，挡住 HEAD 之后另一次发布抢先写入的竞态。
          'x-oss-forbid-overwrite': 'true',
        },
        meta: { sha256: object.sha256 },
      });
      log(`已上传 ${object.key}`);
      return;
    } catch (err) {
      const status = err?.status ?? err?.res?.status;
      if (status !== 409 && err?.code !== 'FileAlreadyExists') throw err;
      existing = await remoteSha256(client, object.key);
    }
  }
  if (existing === null) {
    throw new Error(`${object.key} 写入冲突后远端对象又消失了，请重试`);
  }
  if (existing !== object.sha256) {
    throw new Error(
      `${object.key} 已发布过不同内容（远端 sha256 ${existing}，本次 ${object.sha256}）；同一版本的手册不可覆盖`,
    );
  }
  log(`远端已有相同内容，跳过上传 ${object.key}`);
}

async function verifyCdn(fetchImpl, object, log) {
  // 带一次性查询参数绕开 CDN 可能缓存的发布前 404（同 releaseNotesService 的 ?t=）。
  const response = await fetchImpl(`${object.url}?t=${Date.now()}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`CDN 读取失败 ${object.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== object.body.length || sha256(bytes) !== object.sha256) {
    throw new Error(`CDN 内容与本次构建不一致: ${object.url}`);
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (type !== object.contentType.split(';')[0]) {
    throw new Error(`CDN Content-Type 不符（${type}）: ${object.url}`);
  }
  log(`已核对 ${object.url}`);
}

export async function runPublishPageManual(argv, deps = defaultDeps()) {
  const { buildInfoPath, region, mode } = parsePublishPageManualArgs(argv);
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  if (buildInfo.region !== region) {
    throw new Error(`--region=${region} 与 build-info.region=${buildInfo.region} 不一致`);
  }
  if (buildInfo.versionless || typeof buildInfo.version !== 'string') {
    throw new Error('build-info 没有发版版本号：无版本构建不发布页面手册');
  }
  const { version } = buildInfo;
  const manualRelative = pluginPageManualCdnPath(version);
  const manifestRelative = pluginPageManualManifestCdnPath(version);

  // 先核对 checkout：错的 checkout 不能被当成「这次构建没有手册」静默跳过。
  const head = deps.git.head(deps.repoRoot);
  if (!buildInfo.commitSha || head !== buildInfo.commitSha) {
    throw new Error(
      `当前 checkout 的 commit（${head}）不是构建 commit（${buildInfo.commitSha}），无法确认手册就是本次构建内置的版本`,
    );
  }
  const manual = deps.git.readCommittedFile(deps.repoRoot, buildInfo.commitSha, MANUAL_REPO_PATH);
  if (manual === null) {
    deps.log(`跳过：本次构建未内置 PAGE-GENERATION.md（${MANUAL_REPO_PATH}）`);
    return { status: 'skipped' };
  }
  if (!deps.git.isPathClean(deps.repoRoot, MANUAL_REPO_PATH)) {
    throw new Error(`${MANUAL_REPO_PATH} 有未提交改动，不是构建 commit 里的内容`);
  }

  const manualSha256 = sha256(manual);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: PLUGIN_PAGE_MANUAL_MANIFEST_SCHEMA_VERSION,
        version,
        sha256: manualSha256,
        size: manual.length,
      },
      null,
      2,
    )}\n`,
  );

  deps.applyReleaseConfig(region, mode);
  let prefix;
  let cdnBase;
  if (mode === 'publish') {
    ({ prefix, cdnBase } = deps.resolveOssConfig(region));
  } else {
    prefix = readReleaseTarget(deps, region, 'prefix', { required: false });
    cdnBase = readReleaseTarget(deps, region, 'cdnBase', { required: mode === 'check-cdn' });
  }
  // 先传正文，最后写 manifest：manifest 出现即表示这一版已完整发布。
  const objects = [
    { relative: manualRelative, body: manual, sha256: manualSha256, contentType: 'text/markdown; charset=utf-8' },
    { relative: manifestRelative, body: manifest, sha256: sha256(manifest), contentType: 'application/json' },
  ].map((object) => ({ ...object, key: joinUrl(prefix, object.relative), url: joinUrl(cdnBase, object.relative) }));

  deps.log(`页面手册 ${region} ${version} sha256=${manualSha256} size=${manual.length}`);
  if (mode === 'dry-run') {
    for (const object of objects) deps.log(`[dry-run] ${object.key} -> ${object.url} (${object.body.length} bytes)`);
    return { status: 'dry-run', objects };
  }
  if (mode === 'publish') {
    const client = deps.createClient(region);
    for (const object of objects) await putImmutable(client, object, deps.log);
  }
  for (const object of objects) await verifyCdn(deps.fetch, object, deps.log);
  return { status: mode === 'publish' ? 'published' : 'verified', objects };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPublishPageManual(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
