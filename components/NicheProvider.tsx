'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';

interface NicheFilter {
  minScore: number;
  maxScore: number;
  sort: string;
  search: string;
  from: string | null;
  to: string | null;
}

interface NicheContextType {
  selectedKeyword: string | null;
  setSelectedKeyword: (kw: string | null) => void;
  filter: NicheFilter;
  setFilter: React.Dispatch<React.SetStateAction<NicheFilter>>;
  syncing: boolean;
  setSyncing: (v: boolean) => void;
  syncProgress: Record<string, unknown> | null;
  setSyncProgress: (v: Record<string, unknown> | null) => void;
}

const NicheContext = createContext<NicheContextType | null>(null);

export function useNiche() {
  const ctx = useContext(NicheContext);
  if (!ctx) throw new Error('useNiche must be used within NicheProvider');
  return ctx;
}

export function NicheProvider({ children }: { children: React.ReactNode }) {
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);
  const [filter, setFilter] = useState<NicheFilter>({
    minScore: 80,
    maxScore: 100,
    sort: 'date',
    search: '',
    from: null,
    to: null,
  });
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<Record<string, unknown> | null>(null);

  return (
    <NicheContext.Provider value={{
      selectedKeyword, setSelectedKeyword,
      filter, setFilter,
      syncing, setSyncing,
      syncProgress, setSyncProgress,
    }}>
      {children}
    </NicheContext.Provider>
  );
}
