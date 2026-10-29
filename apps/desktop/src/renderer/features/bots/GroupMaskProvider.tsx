import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import type { ChatMaskAction, ChatMaskMention, ChatMaskState } from '../../../shared/botGroupChat';
import { GroupMaskContext, maskIdentity, type GroupMaskPresentation, type GroupMaskSettings } from './groupMaskPresentation';

/** Server owns activation, persistence and cancellation. This adapter never sends a group reply. */
export function GroupMaskProvider({ groupId, children }: { groupId: string; children: ReactNode }) {
  const supplied = useContext(GroupMaskContext);
  return supplied ? children : <ServerMaskProvider key={groupId} groupId={groupId}>{children}</ServerMaskProvider>;
}
function ServerMaskProvider({ groupId, children }: { groupId: string; children: ReactNode }) {
  const [state,setState]=useState<ChatMaskState|null>(null);
  const [mentions,setMentions]=useState<ChatMaskMention[]>([]);
  const [saving,setSaving]=useState(false), [error,setError]=useState(false), [connectionLost,setConnectionLost]=useState(false);
  const alive=useRef(true), version=useRef(0), authority=useRef(0), busy=useRef(false), pending=useRef(false);
  const stateRef=useRef(state); stateRef.current=state;
  const failed=useRef<(() => Promise<void>)|null>(null);
  const queue=useRef(Promise.resolve());
  const lastParticipation=useRef(0);
  const reload=useCallback(async () => {
    const api=window.electronAPI.maker.chatServer;
    if (!api.mask || !api.mentions) return;
    if (busy.current) { pending.current=true; return; }
    busy.current=true;
    const owner=getDataOwnerGeneration(), revision=version.current;
    const current=()=>alive.current && isDataOwnerGenerationCurrent(owner) && version.current===revision;
    try {
      const response=await api.mask({groupId});
      if (!current()) return;
      if (!response.ok) {
        if (['CONVERSATION_NOT_FOUND', 'OWNER_CHANGED', 'HUMAN_REQUIRED', 'UNSUPPORTED_OPERATION'].includes(response.errorCode)) {
          authority.current++; failed.current=null; stateRef.current=null; setState(null); setMentions([]);
        } else if (stateRef.current) { setError(true); setConnectionLost(true); }
        return;
      }
      setState(response.state);
      const all:ChatMaskMention[]=[];
      let before:string|undefined;
      do {
        const page=await api.mentions({groupId,before});
        if (!current()) return;
        if (!page.ok) throw new Error(page.errorCode);
        all.push(...page.mentions);
        if (!page.hasMore || !page.mentions.length) break;
        before=page.mentions.at(-1)!.sequence;
      } while(current());
      if(current()) { setMentions(all); setError(failed.current !== null); setConnectionLost(false); }
    } catch { if(current()) { setError(true); setConnectionLost(true); } }
    finally {
      busy.current=false;
      if(pending.current && alive.current) { pending.current=false; void reload(); }
    }
  },[groupId]);
  useEffect(()=>{
    alive.current=true; void reload();
    const stop=window.electronAPI.maker.onBotGroupChanged((event,stamp)=>{
      if(isDataOwnerPushCurrent(stamp) && (event.groupId===groupId || !event.groupId)) void reload();
    });
    // Time windows and absence expiry still change when no message is arriving.
    const timer=setInterval(()=>void reload(),15000);
    return ()=>{alive.current=false; version.current++; clearInterval(timer); stop();};
  },[groupId,reload]);
  const act=useCallback((makeAction:(current:ChatMaskState)=>ChatMaskAction)=>{
    const owner=getDataOwnerGeneration(), generation=authority.current;
    let operationId=crypto.randomUUID();
    let action:ChatMaskAction|undefined;
    const send=async()=>{
      if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current || !stateRef.current) return;
      action ??= makeAction(stateRef.current);
      version.current++; setSaving(true); setError(false);
      try {
        const response=await window.electronAPI.maker.chatServer.mask!({groupId,action,operationId});
        if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current) return;
        if(!response.ok) {
          // A definitive revision rejection made no change. Retry against the
          // refreshed state; transport failures retain the original idempotency key.
          if(response.errorCode === 'REVISION_CONFLICT') { action=undefined; operationId=crypto.randomUUID(); }
          throw new Error(response.errorCode);
        }
        stateRef.current=response.state; setState(response.state); failed.current=null;
      } catch { if(alive.current && isDataOwnerGenerationCurrent(owner) && generation===authority.current) {setError(true);failed.current=send;} }
      finally {if(alive.current){setSaving(false);void reload();}}
    };
    queue.current=queue.current.then(send,send);
  },[groupId,reload]);
  const markRead=useCallback((messageIds?: readonly string[])=>{
    const owner=getDataOwnerGeneration(), generation=authority.current, ids=mentions.filter(m=>!messageIds || messageIds.includes(m.messageId)).map(m=>m.messageId);
    if (!ids.length) return;
    const send=async()=>{
      if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current) return;
      version.current++; setSaving(true);
      try {
        for(let i=0;i<ids.length;i+=100){
          if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current) return;
          const result=await window.electronAPI.maker.chatServer.mentions!({groupId,readIds:ids.slice(i,i+100),operationId:crypto.randomUUID()});
          if(!result.ok) throw new Error(result.errorCode);
        }
        if(alive.current && isDataOwnerGenerationCurrent(owner) && generation===authority.current) {failed.current=null;setMentions(previous=>previous.filter(m=>!ids.includes(m.messageId)));}
      }catch{if(alive.current && isDataOwnerGenerationCurrent(owner) && generation===authority.current){setError(true);failed.current=send;}}
      finally{if(alive.current){setSaving(false);void reload();}}
    };
    queue.current=queue.current.then(send,send);
  },[mentions,groupId,reload]);
  // Keep shared composer, settings and attention consumers on one stable projection.
  const value=useMemo<GroupMaskPresentation|null>(()=>{
  if(!state) return null;
  const update=(patch:Partial<GroupMaskSettings>)=>act(current=>({type:'save',expectedRevision:current.revision,
    settings:{...current.settings,companionId:current.settings.companionId ?? current.defaultCompanionId ?? null,...patch,timeZone:current.revision ? current.settings.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone}}));
  return {groupId,self:maskIdentity(state.self),companions:state.companions.map(maskIdentity),
    toolAccessSupported:state.toolAccessSupported,settings:{...state.settings,companionId:state.settings.companionId ?? state.defaultCompanionId ?? null},status:connectionLost && state.status==='enabled' ? 'offline' : state.status,saving,error,loading:false,manualRunning:state.manualRunning,
    update,retry:()=>{if(failed.current) queue.current=queue.current.then(failed.current,failed.current);else void reload();},
    participate:()=>{if(Date.now()-lastParticipation.current<2000)return;lastParticipation.current=Date.now();act(()=>({type:'participate'}));},
    resume:()=>{lastParticipation.current=0;act(()=>({type:'resume'}));},stopManual:()=>act(()=>({type:'stop'})),
    requestDigest:()=>act(()=>({type:'digest'})),digestStatus:state.digestStatus,
    attributions:{},unreadMentions:mentions.map(m=>({...m,...(m.reply?{reply:{...m.reply,companion:maskIdentity(m.reply.companion)}}:{})})),markMentionsRead:markRead,
  };
  },[state,mentions,saving,error,connectionLost,act,reload,groupId,markRead]);
  return value ? <GroupMaskContext.Provider value={value}>{children}</GroupMaskContext.Provider> : children;
}
