'use client';

import React from 'react';
import XPostPreview from './XPostPreview';

interface ThreadTweet {
  text: string;
  media?: string[];
}

interface XThreadProps {
  tweets: ThreadTweet[];
}

export default function XThread({ tweets }: XThreadProps) {
  return (
    <div className="space-y-0">
      {tweets.map((tweet, i) => (
        <div key={i} className={i > 0 ? '-mt-px' : ''}>
          <XPostPreview
            text={tweet.text}
            media={tweet.media}
            isThread={tweets.length > 1}
            isLast={i === tweets.length - 1}
          />
        </div>
      ))}
    </div>
  );
}
