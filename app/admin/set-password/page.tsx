'use client';

import { useEffect, useState } from 'react';

export default function AdminSetPasswordPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  // admin login state
  const [adminUser, setAdminUser] = useState('admin');
  const [adminPass, setAdminPass] = useState('');
  const [loginErr, setLoginErr] = useState('');

  // set-password form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/admin/auth')
      .then((r) => r.json())
      .then((d) => setAuthed(!!d.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginErr('');
    const r = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: adminUser, password: adminPass }),
    });
    if (r.ok) setAuthed(true);
    else setLoginErr('Invalid admin credentials.');
  }

  async function setUserPassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const r = await fetch('/api/admin/set-user-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok
        ? { ok: true, text: `✓ Password set for ${d.email}. They can now log in at /login.` }
        : { ok: false, text: d.error || 'Failed to set password.' });
    } catch {
      setMsg({ ok: false, text: 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full px-4 py-3 rounded-xl border border-zinc-200 bg-white text-[15px] text-zinc-950 outline-none focus:border-zinc-400 transition';
  const btn = 'w-full px-4 py-3 rounded-xl bg-zinc-950 text-white font-semibold text-[14.5px] hover:bg-zinc-800 disabled:opacity-60 transition';

  if (authed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-zinc-50 text-zinc-400">Loading…</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-sm">
        {!authed ? (
          <>
            <h1 className="text-xl font-bold text-zinc-950 text-center mb-1">Admin login</h1>
            <p className="text-[13.5px] text-zinc-500 text-center mb-6">Sign in to set a user&apos;s password.</p>
            <form onSubmit={login} className="space-y-3">
              <input className={input} placeholder="Admin username" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
              <input className={input} type="password" placeholder="Admin password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} autoComplete="current-password" />
              {loginErr && <p className="text-[13px] text-red-600 px-1">{loginErr}</p>}
              <button className={btn} type="submit">Log in</button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-zinc-950 text-center mb-1">Set a user&apos;s password</h1>
            <p className="text-[13.5px] text-zinc-500 text-center mb-6">Recovers a Google-orphaned account. Existing accounts only.</p>
            <form onSubmit={setUserPassword} className="space-y-3">
              <input className={input} type="email" placeholder="User email (e.g. sigadiga@gmail.com)" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              <input className={input} type="text" placeholder="New password (min 8 chars)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              {msg && <p className={`text-[13px] px-1 ${msg.ok ? 'text-emerald-600' : 'text-red-600'}`}>{msg.text}</p>}
              <button className={btn} type="submit" disabled={busy}>{busy ? 'Setting…' : 'Set password'}</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
