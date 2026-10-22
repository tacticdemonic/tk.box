import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {invalidate} from './hooks.js';

// One provider import, as the server reports it. No percentage exists, so none is shown.
export type ImportState='queued'|'running'|'completed'|'failed'|'interrupted';
// The guide outcome, reported separately from the import outcome: a guide can be complete,
// a partial fallback, unmatched, empty, or retained from an earlier import.
export type GuideState='available'|'partial'|'unmatched'|'empty'|'failed'|'disabled';
export type GuideStatus={source:'xmltv'|'short_epg'|'none';state:GuideState;code?:string;requested?:number;succeeded?:number;skipped?:number;mappedChannels?:number;parsedPrograms?:number;rejected?:number;httpStatus?:number;elapsedMs?:number;limit?:number;bytes?:number;primary?:{state:'available'|'unmatched'|'failed';code?:string;httpStatus?:number;elapsedMs?:number}};
export type ImportJob={id:string;accountId:string;state:ImportState;stage:string|null;error:string|null;guideError:string|null;guide?:GuideStatus|null;includeEpg:boolean;createdAt:number;startedAt:number|null;finishedAt:number|null};
export type ImportStatus={active:ImportJob|null;latest:ImportJob|null};

export const IMPORT_POLL_MS=3000;
const accountOf=async()=>(await api<{accounts:{id:string}[]}>('/xtream/accounts')).accounts[0]?.id;

// Follows the provider import that belongs to this viewer. The first import decides whether an
// empty guide is a result or still a wait, so status is read even before any channel exists.
export function useImportProgress(enabled:boolean,onPublished?:()=>void) {
  const [status,setStatus]=useState<ImportStatus>(),[error,setError]=useState(''),[channels,setChannels]=useState<{id:string;name:string}[]>();
  const published=useRef<string|undefined>(undefined);
  useEffect(()=>{
    setStatus(undefined);setError('');setChannels(undefined);published.current=undefined;
    if(!enabled)return;
    let live=true;
    void api<{channels:{id:string;name:string}[]}>('/iptv/channels').then(list=>{if(live)setChannels(list.channels);}).catch(()=>{if(live)setChannels([]);});
    void (async()=>{
      const account=await accountOf();
      if(!account)return {active:null,latest:null};
      return api<ImportStatus>(`/xtream/accounts/${account}/imports`);
    })().then(next=>{
      if(!live||!next)return;
      setStatus(next);
      if(next.latest?.state==='completed'){published.current=next.latest.id;onPublished?.();}
    }).catch(e=>{if(live)setError((e as Error).message);});
    return()=>{live=false;};
  },[enabled]);
  const active=status?.active;
  // Poll while work is pending, then once more so the new catalogue and guide are re-read.
  useEffect(()=>{
    if(!enabled||!active)return;
    let live=true,busy=false,account:string|undefined;
    const timer=setInterval(async()=>{
      if(busy)return;busy=true;
      try{
        account??=await accountOf();
        if(!account)return;const current=account;
        const next=await api<ImportStatus>(`/xtream/accounts/${current}/imports`);
        if(!live)return;
        setStatus(next);
        if(next.active)return;
        clearInterval(timer);
        if(next.latest?.state==='completed'&&published.current!==next.latest.id){published.current=next.latest.id;onPublished?.();}
        const list=await api<{channels:{id:string;name:string}[]}>('/iptv/channels');
        if(live)setChannels(list.channels);
      }catch(e){if(live&&!(e as {status?:number}).status)setError((e as Error).message);}
      finally{busy=false;}
    },IMPORT_POLL_MS);
    return()=>{live=false;clearInterval(timer);};
  },[enabled,active?.id]);
  return {status,active,error,channels,
    // Joins the account's current import; the manager never starts a second one.
    retry:async()=>{
      const account=await accountOf();
      if(!account)throw new Error('No provider is connected.');
      await api(`/xtream/accounts/${account}/refresh`,'POST',{includeEpg:true});
      invalidate('/xtream/accounts');
      setStatus(await api<ImportStatus>(`/xtream/accounts/${account}/imports`));
    }};
}
export type ImportProgress=ReturnType<typeof useImportProgress>;

// What the import is doing, in the words a viewer needs. A catalogue failure is never presented
// as a bad password: the session already proves the credentials were accepted.
export function importMessage(status:ImportStatus|undefined,hasChannels:boolean) {
  const job=status?.active;
  if(job)return {tone:'busy' as const,
    text:job.state==='queued'?'Signed in. Waiting to load channels…':hasChannels?'Signed in. Refreshing channels…':'Signed in. Loading channels…',
    detail:job.stage==='publish'?'Saving the channel list.':job.includeEpg?'Reading the channel list and guide.':'Reading the channel list.'};
  const last=status?.latest;
  if(last?.state==='failed')return {tone:'error' as const,
    text:hasChannels?'The channel list could not be refreshed.':'Channels could not be loaded.',
    detail:last.error==='XTREAM_TIMEOUT'?'The provider did not respond in time. Your sign-in still stands.'
      :last.error==='XTREAM_EMPTY_CATALOGUE'?'The provider returned no channels. The last known list is still in use.'
      :'The provider import did not finish. Your sign-in still stands.'};
  if(last?.state==='interrupted')return {tone:'error' as const,text:'The channel import was interrupted.',detail:'The server restarted or the import was cancelled. Retry when ready.'};
  // A guide problem is described by what the viewer has, not by which request failed.
  const guide=last?.state==='completed'?last.guide:undefined;
  if(guide){
    const coverage=guide.mappedChannels&&guide.requested?` Covering ${guide.mappedChannels} of ${guide.requested} requested channels.`:'';
    if(guide.state==='available')return undefined;
    if(guide.state==='partial')return {tone:'warning' as const,text:'Guide partially loaded.',detail:`The provider guide could not be used, so listings cover only part of the lineup.${coverage||' Some channels will show no guide data.'}`};
    if(guide.state==='unmatched')return {tone:'warning' as const,text:'Guide loaded, but no channels matched.',detail:'The provider returned a guide whose channel ids do not match this lineup. Channels are unaffected; a manual guide match may fix it.'};
    if(guide.state==='empty')return {tone:'warning' as const,text:'Guide loaded, but it has no listings.',detail:'The provider returned a valid guide without current programmes. Channels are unaffected.'};
    if(guide.state==='failed'&&guide.code==='XTREAM_GUIDE_RETAINED')return {tone:'warning' as const,text:'The guide could not be refreshed. The last known guide is still shown.',detail:`Reason: ${code(guide.primary?.code??guide.code)}. Previously loaded listings are unchanged.`};
    return {tone:'warning' as const,text:'Channels loaded, but the guide did not.',detail:`Reason: ${code(guide.code??last?.guideError??'')}${guide.httpStatus?` (HTTP ${guide.httpStatus})`:''}. Channels are unaffected.`};
  }
  if(last?.state==='completed'&&last.guideError)return {tone:'warning' as const,text:'Channels loaded, but the guide did not.',detail:`Guide problem: ${code(last.guideError)}. Channels are unaffected.`};
  return undefined;
}
const code=(value:string)=>value.replaceAll('_',' ').toLowerCase();
