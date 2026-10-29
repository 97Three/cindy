import {
  App,
  applyHostStyleVariables,
  applyDocumentTheme,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
const app = new App({ name: '插件文件交互演示', version: '1.0.0' }, {}, { autoResize: true });
const status = document.querySelector('#status'),
  bar = document.querySelector('progress'),
  list = document.querySelector('#files');
let latestImage,
  latestFile,
  busy = false;
function theme(context) {
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.theme) applyDocumentTheme(context.theme);
}
app.onhostcontextchanged = theme;
// 显示图片/文件（不需要可以删）；URL 由 Host 签发，不自行拼接。
function show(result) {
  if (result.isError)
    throw new Error(result.content?.find((c) => c.type === 'text')?.text || '操作失败');
  for (const file of result.content || []) {
    if (file.type !== 'resource_link') continue;
    latestFile = file;
    const row = document.createElement('li');
    row.textContent = file.name;
    list.append(row);
    const meta = file._meta?.['cindy/file'];
    if (meta?.mimeType.startsWith('image/')) {
      document.querySelector('img').src = meta.url;
    }
    if (file.uri.startsWith('cindy-media:') && meta?.mimeType.startsWith('image/'))
      latestImage = file;
  }
  return result;
}
app.ontoolresult = show;
// 标准进度（不需要可以删 onprogress 和 progress 元素）。
async function call(name, args = {}) {
  const response = await app.callServerTool(
    { name, arguments: args },
    {
      timeout: 30 * 60 * 1000,
      maxTotalTimeout: 30 * 60 * 1000,
      onprogress(value) {
        status.textContent = value.message || '处理中';
        if (value.total) {
          bar.max = value.total;
          bar.value = value.progress;
        } else bar.removeAttribute('value');
      },
    },
  );
  return show(response);
}
async function run(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  bar.removeAttribute('value');
  status.textContent = '处理中';
  try {
    await action();
    bar.max = 1;
    bar.value = 1;
    status.textContent = '已完成';
  } catch (error) {
    bar.value = 0;
    status.textContent = error.message || String(error);
  } finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}
document.querySelector('#pick-image').onclick = () =>
  run(() => call('pick_files', { into: 'media' }));
document.querySelector('#pick-file').onclick = () =>
  run(() => call('pick_files', { into: 'library' }));
// OIDC 联网（不需要可以删）。
document.querySelector('#identity').onclick = () => run(() => call('check_identity'));
// 下载、上传、发图给 AI、拖入分片均可连同对应按钮/工具删除。
document.querySelector('#download').onclick = () => run(() => call('download_attachment'));
document.querySelector('#upload').onclick = () => run(() => call('process_and_upload'));
document.querySelector('#save').onclick = () =>
  run(async () => {
    if (!latestFile) throw new Error('请先选择或下载文件');
    if (!app.getHostCapabilities()?.downloadFile)
      throw new Error('当前查看端不支持另存为，请在本机桌面端操作');
    const saved = await app.downloadFile({ contents: [latestFile] });
    if (saved.isError) throw new Error('已取消另存为');
  });
document.querySelector('#send-image').onclick = () =>
  run(async () => {
    if (!latestImage) throw new Error('请先用系统选择框选图，或拖入不超过 16 MiB 的图片');
    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '这是我在插件页面里选的图，请描述画面。' }, latestImage],
    });
  });
async function dropped(file) {
  const opened = await call('begin_file', {
    name: file.name,
    size: file.size,
    mimeType: file.type,
  });
  const streamId = opened.structuredContent.streamId;
  let seq = 1;
  try {
    for (let offset = 0; offset < file.size; offset += 2 * 1024 * 1024) {
      const bytes = new Uint8Array(
        await file.slice(offset, offset + 2 * 1024 * 1024).arrayBuffer(),
      );
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await call('write_file', { streamId, seq: seq++, data: btoa(binary) });
      bar.max = file.size;
      bar.value = offset + bytes.length;
      status.textContent = `导入 ${offset + bytes.length} / ${file.size} 字节`;
    }
    await call('commit_file', { streamId });
  } catch (error) {
    await call('abort_file', { streamId }).catch(() => {});
    throw error;
  }
}
const drop = document.querySelector('#drop');
drop.ondragover = (event) => event.preventDefault();
drop.ondrop = (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (file) run(() => dropped(file));
};
document.querySelector('input').onchange = (event) => {
  if (event.target.files[0]) run(() => dropped(event.target.files[0]));
};
document.addEventListener('paste', (event) => {
  const file = [...(event.clipboardData?.files || [])][0];
  if (file) {
    event.preventDefault();
    run(() => dropped(file));
  }
});
await app.connect();
theme(app.getHostContext() || {});
