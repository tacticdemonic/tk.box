import {useEffect,useState} from 'react';
import {api} from './api.js';
import {useApi,invalidate} from './hooks.js';
import {type ImportStatus} from './import-progress.js';
import {Card,SectionHead,useMutation} from './settings-ui.js';
import {Empty,ErrorNotice,Icon,Loading,Modal} from './components.js';

// One Xtream provider account as the server reports it: status metadata only, never credentials.
export type XtreamAccount = {
  id: string; name: string; serverOrigin: string; revision: number; enabled: boolean;
  lastValidated: number | null; lastError: string | null; catalogueAt: number | null; catalogueChannels: number | null;
  accountStatus: string | null; expiresAt: number | null; maxConnections: number | null; activeConnections: number | null;
  isTrial: boolean; ownerAccountId: string | null; createdAt: number; updatedAt: number;
};
type AccountsView = {accounts: XtreamAccount[]; usage?: {operations: number; accounts: number}};
type AccountInput = {name: string; serverUrl: string; username: string; password: string; allowInsecureHttp: boolean};

const dateTime = (value: number | null) => value === null ? '—' : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(value);
const state = (account: XtreamAccount) => {
  if (!account.enabled) return {label: 'Disabled', tone: 'danger' as const};
  if (account.accountStatus === 'inactive') return {label: 'Inactive', tone: 'danger' as const};
  if (account.expiresAt !== null && account.expiresAt <= Date.now()) return {label: 'Expired', tone: 'danger' as const};
  if (account.lastError) return {label: 'Error', tone: 'warning' as const};
  if (account.accountStatus === 'active') return {label: account.isTrial ? 'Trial' : 'Active', tone: 'ok' as const};
  return {label: 'Unchecked', tone: '' as const};
};

// Provider accounts granted to the signed-in account. Adding one is a provider login, not a new
// application identity: the existing session and grants stay unchanged.
export function XtreamSettings() {
  const view = useApi<AccountsView>('/xtream/accounts'), [adding, setAdding] = useState(false), mutation = useMutation(view.reload);
  const accounts = view.data?.accounts ?? [];
  useEffect(() => {
    const timer = window.setInterval(view.reload, 30000);
    return () => window.clearInterval(timer);
  }, []);
  return <>
    <SectionHead title="Xtream providers" description="Live TV subscriptions this account can watch. Credentials stay on the server and are never shown here.">
      <button className="primary" onClick={() => setAdding(true)}>Add provider</button>
    </SectionHead>
    {view.loading && !view.data ? <Loading/> : view.error && !view.data ? <ErrorNotice message={view.error.message} retry={view.reload}/> :
      !accounts.length ? <Empty title="No providers yet">Add an Xtream subscription to bring its Live TV channels into the guide.</Empty> :
      <div>{accounts.map(account => <AccountCard key={account.id} account={account} changed={view.reload} mutation={mutation}/>)}</div>}
    {adding && <AddProvider onClose={() => setAdding(false)} created={view.reload}/>}
  </>;
}

function AccountCard({account, changed, mutation}:{account: XtreamAccount; changed: () => void; mutation: ReturnType<typeof useMutation>}) {
  const [editing, setEditing] = useState(false), badge = state(account), [job, setJob] = useState<ImportStatus>();
  // Bumped after a refresh is accepted, so the poll re-reads status for work this card just started.
  const [poll, setPoll] = useState(0);
  // The refresh route accepts work and answers at once; the import's own status is polled here and
  // stops as soon as it reaches a terminal state.
  useEffect(() => {
    let live = true, timer: number | undefined;
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const read = async () => {
      const next = await api<ImportStatus>(`/xtream/accounts/${account.id}/imports`);
      if (!live) return;
      setJob(next);
      if (next.active) { if (timer === undefined) timer = window.setInterval(() => void read().catch(() => {}), 3000); }
      else { stop(); changed(); }
    };
    void read().catch(() => {});
    return () => { live = false; stop(); };
  }, [account.id, poll]);
  const active = job?.active ?? null;
  const refresh = () => void mutation.run(async () => {
    await api(`/xtream/accounts/${account.id}/refresh`, 'POST', {includeEpg: true});
    invalidate('/xtream/accounts');
    setPoll(value => value + 1);
  });
  const toggle = () => void mutation.run(async () => {
    await api(`/xtream/accounts/${account.id}`, 'PATCH', {expectedRevision: account.revision, enabled: !account.enabled});
  });
  return <Card title={account.name} description={<>{account.serverOrigin}</>} actions={<>
    <button className="text-button" disabled={mutation.busy || !!active} onClick={refresh}><Icon name="restart" size={16}/> {active ? 'Importing…' : 'Refresh'}</button>
    <button className="text-button" disabled={mutation.busy} onClick={() => setEditing(true)}>Settings</button>
    <button className="text-button" disabled={mutation.busy} onClick={toggle}>{account.enabled ? 'Disable' : 'Enable'}</button>
  </>}>
    <div className="stat-grid">
      <div className={`stat ${badge.tone}`}><span>Status</span><strong>{badge.label}</strong></div>
      <div className="stat"><span>Channels</span><strong>{account.catalogueChannels ?? '—'}</strong><small>{account.catalogueAt ? `Refreshed ${dateTime(account.catalogueAt)}` : 'Not refreshed yet'}</small></div>
      <div className="stat"><span>Expires</span><strong>{dateTime(account.expiresAt)}</strong>{account.isTrial && <small>Trial account</small>}</div>
      <div className="stat"><span>Connections</span><strong>{account.maxConnections ?? '—'}</strong><small>{account.activeConnections !== null ? `${account.activeConnections} in use` : 'Provider limit'}</small></div>
    </div>
    {active && <p className="small" role="status">{active.state === 'queued' ? 'Import queued.' : active.stage === 'publish' ? 'Saving the channel list…' : 'Loading channels and guide…'} Cached channels stay available meanwhile.</p>}
    {!active && job?.latest?.state === 'failed' && <p className="small danger" role="status">Import failed: {(job.latest.error ?? 'XTREAM_UNREACHABLE').replaceAll('_', ' ').toLowerCase()}. The last known channel list is still in use.</p>}
    {!active && job?.latest?.state === 'interrupted' && <p className="small danger" role="status">Import was interrupted. Refresh again to restart it.</p>}
    {!active && job?.latest?.state === 'completed' && job.latest.guideError && <p className="small warning-text" role="status">Guide problem: {job.latest.guideError.replaceAll('_', ' ').toLowerCase()}. Channels are unaffected.</p>}
    {account.lastError && <p className="small warning-text">Last problem: {account.lastError.replaceAll('_', ' ').toLowerCase()}. The last known channel list stays in use until a refresh succeeds.</p>}
    {mutation.error && <p className="small danger">{mutation.error}</p>}
    {editing && <EditProvider account={account} onClose={() => setEditing(false)} changed={changed}/>}
  </Card>;
}

function AddProvider({onClose, created}:{onClose: () => void; created: () => void}) {
  const [value, setValue] = useState<AccountInput>({name: '', serverUrl: '', username: '', password: '', allowInsecureHttp: false});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api(`/xtream/accounts`, 'POST', {name: value.name || new URL(value.serverUrl).hostname, credentials: value, validate: true});
      created(); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title="Add Xtream provider" onClose={() => { if (!busy) onClose(); }}>
    <h2>Connect a provider</h2>
    <p className="muted">Enter the panel address and the subscription's Xtream credentials. tk.box checks them with the provider; the password is stored encrypted and never shown again.</p>
    <form className="form-stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label>Name<input value={value.name} maxLength={120} placeholder="Primary provider" onChange={e => setValue({...value, name: e.target.value})}/></label>
      <label>Server address<input value={value.serverUrl} required maxLength={2048} placeholder="https://provider.example:8443" onChange={e => setValue({...value, serverUrl: e.target.value})}/></label>
      <label>Username<input value={value.username} required maxLength={128} autoComplete="username" onChange={e => setValue({...value, username: e.target.value})}/></label>
      <label>Password<input type="password" value={value.password} required maxLength={128} autoComplete="current-password" onChange={e => setValue({...value, password: e.target.value})}/></label>
      <label><input type="checkbox" checked={value.allowInsecureHttp} onChange={e => setValue({...value, allowInsecureHttp: e.target.checked})}/> The panel uses plain HTTP</label>
      {error && <ErrorNotice message={error}/>}
      <div className="button-row"><button className="primary" disabled={busy}>{busy ? 'Checking…' : 'Connect'}</button><button type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

function EditProvider({account, onClose, changed}:{account: XtreamAccount; onClose: () => void; changed: () => void}) {
  const [name, setName] = useState(account.name), [password, setPassword] = useState(''), [username, setUsername] = useState(''), [serverUrl, setServerUrl] = useState(account.serverOrigin), [insecure, setInsecure] = useState(false), [confirm, setConfirm] = useState(false);
  const mutation = useMutation(() => { changed(); invalidate('/xtream/accounts'); });
  const save = () => void mutation.run(async () => {
    const credentials = password ? {serverUrl, username, password, allowInsecureHttp: insecure} : undefined;
    await api(`/xtream/accounts/${account.id}`, 'PATCH', credentials ? {expectedRevision: account.revision, name, credentials} : {expectedRevision: account.revision, name});
    onClose();
  });
  const remove = () => void mutation.run(async () => {
    await api(`/xtream/accounts/${account.id}`, 'DELETE', {expectedRevision: account.revision});
    changed(); invalidate('/xtream/accounts'); invalidate('/guide'); invalidate('/iptv/channels'); onClose();
  });
  return <Modal title="Provider settings" onClose={() => { if (!mutation.busy) onClose(); }}>
    <h2>{account.name}</h2>
    <form className="form-stack" onSubmit={e => { e.preventDefault(); save(); }}>
      <label>Name<input value={name} maxLength={120} onChange={e => setName(e.target.value)}/></label>
      <p className="muted small">To replace the subscription credentials, fill in all three fields. The saved channel list is cleared until the new account refreshes.</p>
      <label>Server address<input value={serverUrl} maxLength={2048} onChange={e => setServerUrl(e.target.value)}/></label>
      <label>Username<input value={username} maxLength={128} autoComplete="off" onChange={e => setUsername(e.target.value)}/></label>
      <label>New password<input type="password" value={password} maxLength={128} autoComplete="new-password" onChange={e => setPassword(e.target.value)}/></label>
      <label><input type="checkbox" checked={insecure} onChange={e => setInsecure(e.target.checked)}/> The panel uses plain HTTP</label>
      {mutation.error && <ErrorNotice message={mutation.error}/>}
      <div className="button-row"><button className="primary" disabled={mutation.busy}>Save</button><button type="button" disabled={mutation.busy} onClick={onClose}>Cancel</button></div>
    </form>
    <div className="danger-zone"><h3>Remove provider</h3><p className="muted small">Its channels, guide and favourites are removed from this server. Stopped streams end immediately.</p>
      <label><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/> I understand this removes the provider account</label>
      <button className="danger" disabled={!confirm || mutation.busy} onClick={remove}>Remove provider</button></div>
    <p className="muted small">Last checked {dateTime(account.lastValidated)}</p>
  </Modal>;
}
