import { useState, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { CornerDownRight } from 'lucide-react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import type { BotGroupAttachment, BotGroupMessageView, BotGroupThreadShareView } from '@cindy/maker-shared/botGroupChat';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { fontWeight, iconSize, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { ChatThreadSummary } from './ChatThreadSummary';
import { BotGroupAvatar } from './BotGroupAvatars';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { BotGroupMenu } from './BotGroupMenu';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotGroupMarkdownText } from './BotGroupMessageText';
import { MessageContentLongPressContext } from './messageContentLongPress';
import type { ResolveRemoteMediaFn } from './remoteMedia';

type BotGroupThreadSummary = Pick<BotGroupMessageView, 'replyCount' | 'threadPreview' | 'threadUnread'>;

export function BotGroupThreadEntry({ message, summary, identityFor, onPress }: {
  message: BotGroupMessageView; summary?: BotGroupThreadSummary; identityFor: BotGroupIdentityLookup; onPress(): void;
}) {
  const { t } = useTranslation();
  const replyCount = summary?.replyCount ?? message.replyCount ?? (message.threadShare ? 1 : 0);
  const threadPreview = summary?.threadPreview ?? message.threadPreview ?? message.threadShare?.threadPreview;
  const threadUnread = summary?.threadUnread ?? message.threadUnread ?? message.threadShare?.threadUnread;
  const responders = threadPreview?.responders ?? threadPreview?.replies ?? [];
  return <ChatThreadSummary replyCount={replyCount} lastReplyAt={threadPreview?.replies.at(-1)?.createdAt}
    avatars={responders.slice(0, 3).map(reply => <BotGroupAvatar key={reply.id} deviceId="" online identity={identityFor(reply.authorBotId ?? '', reply.authorName)} size={iconSize.lg} />)}
    unread={threadUnread?.count ? t('groupChat.thread.newReplies', { count: threadUnread.count }) + (threadUnread.mentioned ? ` · ${t('groupChat.thread.mentioned')}` : '') : undefined}
    onPress={onPress} testID={`botGroup.thread.${message.id}`}
    accessibilityHint={threadPreview?.replies.map(reply => `${reply.authorName}: ${reply.text}`).join(' · ')} />;
}

export function BotGroupThreadFollow({ nativeHeader = false, following, online, onChange, onError }: {
  nativeHeader?: boolean; following?: boolean; online: boolean; onChange(value: boolean): Promise<boolean>; onError(error: unknown): void;
}) {
  const { t } = useTranslation(); const [busy, setBusy] = useState(false);
  const label = t(following ? 'groupChat.thread.following' : 'groupChat.thread.follow');
  const disabled = following === undefined || !online || busy;
  const toggle = () => {
    if (disabled) return; setBusy(true); void onChange(!following).catch(onError).finally(() => setBusy(false));
  };
  // Toolbar.View can collapse a custom button into UIKit's overflow.
  if (nativeHeader) return <Stack.Toolbar placement="right">
    {following === undefined ? null : <Stack.Toolbar.Button icon={following ? 'bell.fill' : 'bell'}
      accessibilityLabel={label} selected={following} disabled={disabled} onPress={toggle}>{label}</Stack.Toolbar.Button>}
  </Stack.Toolbar>;
  if (following === undefined) return null;
  return <MainWindowActionButton density="compact" action={{ label, active: following,
    disabled, busy, testID: 'botGroup.thread.follow', onPress: toggle }} />;
}

export function BotGroupThreadShare({ share, resolveMedia, resolveServerMedia, onRetry }: {
  share: BotGroupThreadShareView; resolveMedia: ResolveRemoteMediaFn;
  resolveServerMedia?: (id: string, signal?: AbortSignal) => Promise<BotGroupAttachment>; onRetry?(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  return <View style={styles.share} testID="botGroup.thread.share">
    {share.status === 'available' ? <Text style={styles.note}>{t(share.sharedByAuthor ? 'groupChat.thread.sharedOwn' : 'groupChat.thread.sharedOther', { name: share.authorName })}</Text> : null}
    {share.status === 'loading' ? <View style={styles.entry}><ActivityIndicator color={colors.textSecondary} /><Text style={styles.note}>{t('groupChat.thread.sourceLoading')}</Text>{onRetry ? <MainWindowActionButton density="compact" action={{ label: t('groupChat.thread.retry'), onPress: onRetry }} /> : null}</View>
      : share.status === 'unavailable' ? <Text style={styles.note}>{t('groupChat.thread.sourceUnavailable')}</Text>
      : <>
        <Text style={styles.count}>{share.authorName}{share.edited ? ` · ${t('groupChat.thread.edited')}` : ''}</Text>
        {share.attachments.length ? <BotGroupMessageAttachments messageId={share.messageId} attachments={share.attachments} align="left" onResolveRemoteMedia={resolveMedia} resolveServerMedia={resolveServerMedia} /> : null}
        <BotGroupMarkdownText content={share.content} authorKind={share.authorKind} />
      </>}
  </View>;
}

export function BotGroupTopicActions({ message, onQuote, onThread, onShare, onReveal, shared, online, readOnly, children, onShareImage }: {
  children: ReactElement; onShareImage?: () => void;
  message: BotGroupMessageView; onQuote?: () => void; onThread?: () => void; onShare?: () => void; onReveal?: () => void;
  shared?: { messageId: string | null; bySelf: boolean }; online: boolean; readOnly: boolean;
}) {
  const { t } = useTranslation();
  const options = [
    ...(onQuote ? [{ id: 'quote', title: t('groupChat.thread.quoteReply'), disabled: readOnly }] : []),
    ...(onThread ? [{ id: 'thread', title: t(message.replyCount === 0 ? 'groupChat.thread.create' : 'groupChat.thread.open') }] : []),
    ...(onShare && !readOnly ? [{ id: 'share', title: t(shared?.bySelf ? 'groupChat.thread.showInGroup' : 'groupChat.thread.shareToGroup'), disabled: shared?.bySelf ? !shared.messageId : !online }] : []),
    ...(onShareImage ? [{ id: 'image', title: t('session.shareImage.title') }] : []),
    { id: 'copy', title: t('groupChat.thread.copy'), disabled: message.threadShare ? message.threadShare.status !== 'available' : !message.content },
  ];
  const select = (id: string) => {
          if (id === 'image') onShareImage?.(); else if (id === 'quote') onQuote?.(); else if (id === 'thread') onThread?.();
          else if (id === 'share') { if (shared?.bySelf) onReveal?.(); else onShare?.(); }
          else if (id === 'copy') void Clipboard.setStringAsync(message.threadShare?.status === 'available' ? message.threadShare.content : message.content);
        };
  const timedSections = [{ id: 'time', options: [{ id: 'timestamp', title: new Date(message.createdAt).toLocaleString(), disabled: true }] }, { id: 'message', options }];
  return <BotGroupMenu title={t('groupChat.thread.actions')} sections={timedSections} onSelect={select} longPress testID={`botGroup.thread.context.${message.id}`}>
    {open => <MessageContentLongPressContext.Provider value={open}>
      <Pressable onLongPress={open} delayLongPress={350}>{children}</Pressable>
    </MessageContentLongPressContext.Provider>}
  </BotGroupMenu>;
}

export function BotGroupThreadPosted({ messageId, shared, onPress }: {
  messageId: string; shared: { messageId: string | null; bySelf: boolean }; onPress(): void;
}) {
  const { t } = useTranslation(); const styles = useThemedStyles(makeStyles); const { colors } = useTheme();
  return <Pressable onPress={onPress} disabled={!shared.messageId} accessibilityRole="button" style={styles.postedEntry} testID={`botGroup.thread.shared.${messageId}`}>
    <CornerDownRight size={iconSize.xs} color={colors.textTertiary} /><Text style={styles.postedNote}>{t(shared.bySelf ? 'groupChat.thread.postedSelf' : 'groupChat.thread.postedOther')}</Text>
  </Pressable>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  entry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  count: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: colors.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  postedEntry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.lg },
  postedNote: { flexShrink: 1, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  share: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: spacing.md, gap: spacing.sm },
});
