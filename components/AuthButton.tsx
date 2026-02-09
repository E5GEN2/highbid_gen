'use client';

import { useSession, signIn, signOut } from 'next-auth/react';
import { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

export default function AuthButton() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (status === 'loading') {
    return (
      <div className="w-9 h-9 sm:w-10 sm:h-10 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center">
        <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) {
    return (
      <button
        onClick={() => signIn('google')}
        className="w-9 h-9 sm:w-10 sm:h-10 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center text-white active:bg-black/80 transition"
        title="Sign in with Google"
      >
        <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
      </button>
    );
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-9 h-9 sm:w-10 sm:h-10 rounded-full overflow-hidden border-2 border-white/30 active:border-white/60 transition"
        title={session.user.name ?? 'Account'}
      >
        {session.user.image ? (
          <Image
            src={session.user.image}
            alt=""
            width={40}
            height={40}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-pink-600 flex items-center justify-center text-white text-sm font-bold">
            {(session.user.name?.[0] ?? '?').toUpperCase()}
          </div>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-gray-900/95 backdrop-blur-md rounded-xl shadow-lg border border-white/10 overflow-hidden z-[60]">
          <div className="px-4 py-3 border-b border-white/10">
            <p className="text-sm font-medium text-white truncate">{session.user.name}</p>
            <p className="text-xs text-gray-400 truncate">{session.user.email}</p>
          </div>
          <button
            onClick={() => { setOpen(false); signOut(); }}
            className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-white/5 transition"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
