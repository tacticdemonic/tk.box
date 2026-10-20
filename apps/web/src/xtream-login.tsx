import {useState} from 'react';
import {api} from './api.js';
import {ErrorNotice} from './components.js';

type Props = {onSignedIn: () => void; compact?: boolean; bootstrapTokenRequired?: boolean};

// Xtream-only sign-in. The provider credentials authenticate the application session; the panel
// password is sent once and never kept in browser storage.
export function XtreamLogin({onSignedIn, compact = false, bootstrapTokenRequired = false}: Props) {
  const [open, setOpen] = useState(compact), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [serverUrl, setServerUrl] = useState(''), [username, setUsername] = useState(''), [password, setPassword] = useState(''), [insecure, setInsecure] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api('/auth/xtream/login', 'POST', {serverUrl, username, password, allowInsecureHttp: insecure, ...(bootstrapToken ? {bootstrapToken} : {})});
      onSignedIn();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="xtream-login">
    {!open ? <button className="text-button" disabled={busy} onClick={() => setOpen(true)}>Sign in with an Xtream provider</button> : <>
      <h2>Xtream subscription</h2>
      <p className="muted small">Use the login your provider supplied. It signs you in to tk.box and loads that provider's Live TV channels.</p>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <label>Server address<input value={serverUrl} required maxLength={2048} placeholder="https://provider.example:8443" autoComplete="url" onChange={e => setServerUrl(e.target.value)}/></label>
        <label>Username<input value={username} required maxLength={128} autoComplete="username" onChange={e => setUsername(e.target.value)}/></label>
        <label>Password<input type="password" value={password} required maxLength={128} autoComplete="current-password" onChange={e => setPassword(e.target.value)}/></label>
        <label><input type="checkbox" checked={insecure} onChange={e => setInsecure(e.target.checked)}/> The provider uses plain HTTP</label>
        {bootstrapTokenRequired&&<label>Initial administrator token<input type="password" value={bootstrapToken} maxLength={256} autoComplete="off" onChange={e => setBootstrapToken(e.target.value)}/><small>Only the first sign-in on a new server needs this. It is set by the server operator.</small></label>}
        {error && <ErrorNotice message={error}/>}
        <button className="primary large" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </>}
  </div>;
}
