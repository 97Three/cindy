const streams = new Map();
function check(result) {
  if (!result || result.ok === false)
    throw new Error(result?.message || result?.errorCode || '操作失败');
  return result;
}
function link(uri, name, mimeType) {
  return { type: 'resource_link', uri, name, ...(mimeType ? { mimeType } : {}) };
}
function result(data, links = []) {
  return { content: [{ type: 'text', text: '文件操作已完成' }, ...links], structuredContent: data };
}
cindy.onHostMessage(async (message) => {
  if (message.type !== 'tool-call') return;
  const a = message.args || {};
  try {
    let output;
    if (message.tool === 'open_files') output = result({ ready: true });
    // 系统选择框（不需要可以删，连同 pick 声明和按钮）。
    else if (message.tool === 'pick_files') {
      const picked = check(
        await cindy.pick({
          mode: 'file',
          into: a.into === 'media' ? 'media' : 'library',
          multiple: true,
          accept: a.into === 'media' ? ['image/*'] : [],
          path: 'imports',
          callId: message.callId,
        }),
      );
      // Never return Node filesystem paths to the View.
      const files = (picked.files ?? []).map(({ name, size, mimeType, ref }) => ({
        name,
        size,
        mimeType,
        ref,
      }));
      output = result(
        { files },
        files.filter((f) => f.ref).map((f) => link(f.ref, f.name, f.mimeType)),
      );
      // 拖入分片（不需要可以删，同时删对应工具与页面处理）。
    } else if (message.tool === 'begin_file') {
      const name = String(a.name || 'attachment')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/[.]+$/, '')
        .slice(-80);
      const relative = 'imports/file-' + Date.now() + '-' + name;
      const started = check(
        await cindy.library({ op: 'writeBegin', path: relative, totalBytes: a.size }),
      );
      streams.set(started.streamId, {
        path: relative,
        name,
        mimeType: String(a.mimeType || 'application/octet-stream'),
        size: a.size,
      });
      output = result({ streamId: started.streamId });
    } else if (message.tool === 'write_file') {
      if (!streams.has(a.streamId)) throw new Error('文件上传已失效');
      check(
        await cindy.library({
          op: 'writeChunk',
          streamId: a.streamId,
          seq: a.seq,
          content: a.data,
          encoding: 'base64',
        }),
      );
      output = result({ accepted: true });
    } else if (message.tool === 'abort_file') {
      check(await cindy.library({ op: 'writeAbort', streamId: a.streamId }));
      streams.delete(a.streamId);
      output = result({ aborted: true });
    } else if (message.tool === 'commit_file') {
      const file = streams.get(a.streamId);
      if (!file) throw new Error('文件上传已失效');
      const saved = check(await cindy.library({ op: 'writeCommit', streamId: a.streamId }));
      streams.delete(a.streamId);
      const links = [link('library:' + saved.path, file.name, file.mimeType)];
      if (file.mimeType.startsWith('image/') && file.size <= 16 * 1024 * 1024) {
        const read = check(
          await cindy.library({ op: 'read', path: saved.path, encoding: 'base64' }),
        );
        const deposited = check(
          await cindy.send({
            type: 'cindy-request',
            kind: 'deposit_media',
            data: read.content,
            callId: message.callId,
          }),
        );
        links.push(link(deposited.url, file.name, file.mimeType));
      }
      output = result({ sha256: saved.sha256 }, links);
      // 后端下载（不需要可以删）。
    } else if (message.tool === 'download_attachment') {
      const saved = check(
        await cindy.fetch({
          url: 'https://api.example.com/files/download',
          as: 'library',
          path: 'downloads/backend.txt',
          callId: message.callId,
        }),
      );
      if (!saved.library) throw new Error('后端没有返回文件');
      output = result(saved.library, [link(saved.library.ref, 'backend.txt', 'text/plain')]);
      // 本机处理后上传（不需要可以删）。
    } else if (message.tool === 'process_and_upload') {
      // This local processing is plugin code, not a new page-side filesystem API.
      check(
        await cindy.library({
          op: 'write',
          path: 'exports/processed.txt',
          content: 'Processed locally by this plugin.',
        }),
      );
      const uploaded = check(
        await cindy.fetch({
          url: 'https://api.example.com/files/upload',
          method: 'POST',
          upload: { library: ['exports/processed.txt'], field: 'file' },
          callId: message.callId,
        }),
      );
      output = result({ response: uploaded.body, status: uploaded.status }, [
        link('library:exports/processed.txt', 'processed.txt', 'text/plain'),
      ]);
      // OIDC 联网（不需要可以删，并移除 network.secrets）。替换域名/id，按企业作者流程安装。
    } else if (message.tool === 'check_identity') {
      const response = check(
        await cindy.fetch({
          url: 'https://api.example.com/files/identity',
          callId: message.callId,
        }),
      );
      output = result({ status: response.status }); // 不回显后端响应或令牌。
    } else throw new Error('未知工具');
    cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result: output });
  } catch (error) {
    cindy.send({
      type: 'tool-result',
      callId: message.callId,
      ok: true,
      result: { isError: true, content: [{ type: 'text', text: String(error.message || error) }] },
    });
  }
});
