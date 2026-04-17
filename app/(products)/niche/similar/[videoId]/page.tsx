'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function SimilarIndex() {
  const router = useRouter();
  const { videoId } = useParams<{ videoId: string }>();
  useEffect(() => { router.replace(`/niche/similar/${videoId}/videos`); }, [router, videoId]);
  return null;
}
