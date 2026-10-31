// 交互页面生成手册（PAGE-GENERATION.md）的发布路径约定。
//
// 发布脚本 scripts/publish-page-manual.mjs 使用本文件；客户端运行时拼手册地址时也从这里
// 取路径，不另写一份。CDN 地址是 `cdnBaseUrl + "/" + 相对路径`，OSS key 是
// `prefix + "/" + 同一相对路径`（与壁纸、notice 的约定一致）。路径按发版版本号存放，
// 发布后不再改动。

/** 相对内置 system-skills 根目录的手册路径（打包后位于 Resources/system-skills 下同一相对路径）。 */
export const PLUGIN_PAGE_MANUAL_SKILL_PATH =
  'cindy-plugin-creator/references/examples/interactive-pages/PAGE-GENERATION.md';

/** manifest.json 的结构版本。 */
export const PLUGIN_PAGE_MANUAL_MANIFEST_SCHEMA_VERSION = 1;

function manualDir(version) {
  // 只接受发版用的纯 x.y.z（与 package-lib 的 isExplicitVersion 一致），版本号直接进路径。
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`页面手册路径需要 x.y.z 发版版本号，收到: ${String(version)}`);
  }
  return `plugin-pages/manual/${version}`;
}

/** 手册正文相对 CDN 根 / OSS 前缀的路径。 */
export function pluginPageManualCdnPath(version) {
  return `${manualDir(version)}/PAGE-GENERATION.md`;
}

/** 手册 manifest.json（{schemaVersion, version, sha256, size}）相对 CDN 根 / OSS 前缀的路径。 */
export function pluginPageManualManifestCdnPath(version) {
  return `${manualDir(version)}/manifest.json`;
}
