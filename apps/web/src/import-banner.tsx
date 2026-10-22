import {useState} from 'react';
import {importMessage,type ImportProgress} from './import-progress.js';
import {Icon} from './components.js';

// Shown while a provider import is pending, after it fails, and when only the guide failed.
// A running import never blocks the application: cached channels stay usable underneath.
export function XtreamImportBanner({progress}:{progress:ImportProgress}) {
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState('');
  const message=progress.error?{tone:'error' as const,text:'Import status could not be read.',detail:progress.error}
    :importMessage(progress.status,!!progress.channels?.length);
  if(!message)return null;
  const retry=()=>{setBusy(true);setFailure('');void progress.retry().catch(e=>setFailure((e as Error).message)).finally(()=>setBusy(false));};
  if(message.tone==='busy')return <div className="notice subtle import-progress" role="status" aria-live="polite">
    <span className="import-progress-text"><span className="spinner"/><span><strong>{message.text}</strong>{message.detail&&<small>{message.detail}</small>}</span></span>
  </div>;
  return <div className={`notice ${message.tone==='error'?'error':''}`} role="status" aria-live="polite">
    <span className="import-progress-text"><Icon name={message.tone==='error'?'info':'check'} size={18}/><span><strong>{message.text}</strong>{message.detail&&<small>{message.detail}</small>}{failure&&<small>{failure}</small>}</span></span>
    {message.tone!=='warning'&&<button className="text-button" disabled={busy} onClick={retry}><Icon name="restart" size={16}/>{busy?'Retrying…':'Retry'}</button>}
  </div>;
}
