'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function GeneratorIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/generator/create');
  }, [router]);
  return null;
}
