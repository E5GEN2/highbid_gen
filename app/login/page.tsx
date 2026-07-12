'use client';

import { Suspense, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get('callbackUrl') || '/';

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function doCredentialsSignIn() {
    const res = await signIn('credentials', { email, password, redirect: false });
    if (res?.error) {
      setError('Invalid email or password.');
      return false;
    }
    return true;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        const r = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          setError(data.error || 'Could not create account.');
          return;
        }
      }
      const ok = await doCredentialsSignIn();
      if (ok) router.push(callbackUrl);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-950">
            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="text-[14px] text-zinc-500 mt-1">
            {mode === 'signin' ? 'Log in to continue.' : 'No credit card. Start free.'}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-zinc-200 bg-white text-[15px] text-zinc-950 outline-none focus:border-zinc-400 transition"
          />
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            placeholder={mode === 'signin' ? 'Password' : 'Password (min 8 characters)'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-zinc-200 bg-white text-[15px] text-zinc-950 outline-none focus:border-zinc-400 transition"
          />

          {error && <p className="text-[13px] text-red-600 px-1">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-zinc-950 text-white font-semibold text-[14.5px] hover:bg-zinc-800 disabled:opacity-60 transition"
          >
            {busy ? 'Please wait…' : mode === 'signin' ? 'Log in' : 'Sign up'}
          </button>
        </form>

        <p className="text-center text-[13.5px] text-zinc-500 mt-6">
          {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); }}
            className="text-zinc-950 font-semibold hover:underline"
          >
            {mode === 'signin' ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
