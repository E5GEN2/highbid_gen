'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';

export default function NicheKeywordIndex() {
  const router = useRouter();
  const { keyword } = useParams<{ keyword: string }>();
  useEffect(() => {
    router.replace(`/niche/niches/${keyword}/videos`);
  }, [router, keyword]);
  return null;
}
