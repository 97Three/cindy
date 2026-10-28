/**
 * 读取用户**显式**配置的 ENABLE_TOOL_SEARCH(issue #7524)。
 *
 * Cindy 对未知兼容性的上游默认把 ENABLE_TOOL_SEARCH 注入为 'false'(见
 * claude-behavior-flags.ts,#2929 的 fail-closed 防线)。但 flags 合并进子进程环境后优先级
 * 高于 settings.json 的 `env` 块,用户主动写下的 `"ENABLE_TOOL_SEARCH": "true"` 会被静默
 * 覆盖,且无处可改。这里只读这一个键,让用户的显式选择能压过 Cindy 的默认值。
 *
 * 优先级与终端里直接运行 claude 一致:宿主进程环境 > ~/.claude/settings.json 的 env。
 * 只读 `env.ENABLE_TOOL_SEARCH` 一个键,不读取、不记录该文件的其它内容;读不到、解析失败
 * 或值不合法一律视为未配置(回到 Cindy 默认)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code 接受 true / false / auto / auto:N(阈值百分比)。其它值按未配置处理,
// 避免把任意字符串写进子进程环境。
const TOOL_SEARCH_VALUE = /^(?:true|false|auto(?::\d{1,3})?)$/i;

function normalize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return TOOL_SEARCH_VALUE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function readUserToolSearchOverride(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | undefined {
  const fromEnv = normalize(env.ENABLE_TOOL_SEARCH);
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const settingsEnv = (parsed as { env?: Record<string, unknown> } | null)?.env;
    return normalize(settingsEnv?.ENABLE_TOOL_SEARCH);
  } catch {
    return undefined;
  }
}
