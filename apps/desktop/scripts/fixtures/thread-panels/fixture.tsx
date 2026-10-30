import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotDmThreadPanel } from '../../../src/renderer/features/bots/BotDmThreadViews';
import { ChatThreadPanel } from '../../../src/renderer/features/bots/ChatThreadPanel';
import type { BotGroupDetail } from '../../../src/shared/botGroupChat';
import fixturePhoto from '../../../src/renderer/assets/bot-presets/cindy.png';

const sends: unknown[] = [];
const photoUrl = fixturePhoto;
// The fixture's HTTP test origin is not a secure context; production localhost has this API.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

const text = '原消息开头 · Original message\n\n' + Array.from({ length: 6 }, (_,i) =>
  `### ${i + 1}. 完整阅读 · Full text\n\n原消息和回复一起滚动，不应被固定高度遮挡。The entire original message remains readable.\n\n- 第一项 First item\n- 第二项 Second item`).join('\n\n') + '\n\n原消息末尾 · End of original';
const bot = { id: 'fixture-bot', name: 'Aster', avatar: '🧪' };
const root = { id: 'root', sequence: 1, kind: 'message' as const, authorKind: 'bot' as const,
  authorBotId: bot.id, authorName: bot.name, content: text, mentions: { all: false, botIds: [] },
  noticeCode: null, planId: null, files: [], attachments: [], createdAt: 1792990000000 };

function Scenario({ kind }: { kind: string }) {
  const [closed, setClosed] = useState(false);
  return <div className="flex h-screen" data-ui-page-subject>
    <div className="min-w-0 flex-1" />
    {closed ? <span data-closed="" /> : kind.startsWith('group') ? <ChatThreadPanel
      group={{ id: 'fixture-group', members: [], messages: [root] } as unknown as BotGroupDetail}
      rootId="root" onClose={() => setClosed(true)} /> : <BotDmThreadPanel
      bot={bot} rootSessionId="fixture-main" rootClientId="root"
      state={kind === 'failed' ? { kind: 'failed', message: '暂时无法打开话题 · Could not open topic' } : { kind: 'opening' }}
      mentions={[]} lastAssistantAt={null} onRetry={() => undefined} onClose={() => setClosed(true)} />}
  </div>;
}

void mountPage({
  route: '/bots/fixture-bot/session/fixture-main',
  host: ctx => ({
    getFilePath: (file: File) => `/fixture/${file.name}`,
    cacheImageFromPath: async () => ({ url: photoUrl }),
    maker: { onBotGroupChanged: subscription('groupChanged'), chatServer: {
      thread: async () => ({ ok: true,
        root: ctx.case === 'group-attachments' ? { ...root, content: '图片附件验收 · Attachment check' } : root,
        replies: [], hasMore: false }),
      reply: async (input: unknown) => { sends.push(input); return { ok: true, messageId: 'fixture-image-reply' }; },
    } },
  }),
  render: ctx => {
    // Only the source snapshot is simulated; both panels and root rendering are real.
    (window as unknown as { __threadRoot: unknown }).__threadRoot = {
      messages: [{ clientId: 'root', role: 'assistant', content: text, createdAt: new Date(root.createdAt).toISOString() }],
    };
    (window as unknown as { __threadSends: unknown[] }).__threadSends = sends;
    return <Scenario kind={ctx.case} />;
  },
});
