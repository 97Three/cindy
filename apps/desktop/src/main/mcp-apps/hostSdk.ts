import source from '@modelcontextprotocol/ext-apps/app-with-deps?raw';

// Vite embeds the same pinned dependency as AppBridge. Only transient View
// documents carry these bytes, never persisted card results.
export const hostAppSdkAsset = {
  source,
};
