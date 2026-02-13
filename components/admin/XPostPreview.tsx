'use client';

import React from 'react';

interface XPostPreviewProps {
  text: string;
  media?: string[];
  isThread?: boolean;
  isLast?: boolean;
  onCopy?: () => void;
}

function renderTextWithHashtags(text: string) {
  const parts = text.split(/(#\w+)/g);
  return parts.map((part, i) =>
    part.startsWith('#') ? (
      <span key={i} className="text-blue-400">{part}</span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function MediaGrid({ media }: { media: string[] }) {
  if (media.length === 1) {
    return (
      <div className="mt-3 rounded-2xl overflow-hidden border border-gray-800">
        <img src={media[0]} alt="" className="w-full h-64 object-cover" />
      </div>
    );
  }

  if (media.length === 2) {
    return (
      <div className="mt-3 grid grid-cols-2 gap-0.5 rounded-2xl overflow-hidden border border-gray-800">
        {media.map((src, i) => (
          <img key={i} src={src} alt="" className="w-full h-48 object-cover" />
        ))}
      </div>
    );
  }

  if (media.length === 3) {
    return (
      <div className="mt-3 grid grid-cols-2 gap-0.5 rounded-2xl overflow-hidden border border-gray-800">
        <img src={media[0]} alt="" className="w-full h-48 object-cover row-span-2" style={{ gridRow: 'span 2' }} />
        <img src={media[1]} alt="" className="w-full h-[95px] object-cover" />
        <img src={media[2]} alt="" className="w-full h-[95px] object-cover" />
      </div>
    );
  }

  // 4+ images: 2x2 grid
  return (
    <div className="mt-3 grid grid-cols-2 gap-0.5 rounded-2xl overflow-hidden border border-gray-800">
      {media.slice(0, 4).map((src, i) => (
        <img key={i} src={src} alt="" className="w-full h-32 object-cover" />
      ))}
    </div>
  );
}

export default function XPostPreview({ text, media, isThread, isLast, onCopy }: XPostPreviewProps) {
  const charCount = text.length;
  const isOverLimit = charCount > 280;

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    onCopy?.();
  };

  return (
    <div className="relative">
      {/* Thread connector line */}
      {isThread && !isLast && (
        <div className="absolute left-[24px] top-[56px] bottom-0 w-0.5 bg-gray-800" />
      )}

      <div className="bg-black border border-gray-800 rounded-2xl p-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
            R
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-white text-[15px]">rofe.ai</span>
              {/* Blue verified checkmark */}
              <svg viewBox="0 0 22 22" className="w-[18px] h-[18px] text-blue-400 fill-current shrink-0">
                <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.69-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.636.433 1.221.878 1.69.47.446 1.055.752 1.69.883.635.13 1.294.083 1.902-.143.271.586.702 1.084 1.24 1.438.54.354 1.167.551 1.813.569.646-.018 1.273-.215 1.814-.569.54-.354.97-.853 1.246-1.439.616.226 1.285.272 1.934.136.65-.137 1.242-.451 1.715-.909.433-.46.72-1.044.843-1.678.122-.633.066-1.289-.163-1.894.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
              </svg>
              <span className="text-gray-500 text-[15px]">@rofe_ai</span>
              <span className="text-gray-500 text-[15px]">·</span>
              <span className="text-gray-500 text-[15px]">now</span>
            </div>

            {/* Body */}
            <div className="mt-1 text-[15px] text-white whitespace-pre-wrap leading-relaxed">
              {renderTextWithHashtags(text)}
            </div>

            {/* Media */}
            {media && media.length > 0 && <MediaGrid media={media} />}

            {/* Engagement bar */}
            <div className="flex items-center justify-between mt-3 max-w-[425px]">
              {[
                { icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z', count: '' },
                { icon: 'M4 4l7.07 17 2.51-7.39L21 11.07z', count: '' },
                { icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z', count: '' },
                { icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z', count: '' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-1 text-gray-500 hover:text-gray-400 transition cursor-pointer group">
                  <div className="p-2 rounded-full group-hover:bg-gray-900">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                    </svg>
                  </div>
                  {item.count && <span className="text-xs">{item.count}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer: char count + copy */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-800">
          <span className={`text-xs font-mono ${isOverLimit ? 'text-red-500 font-bold' : 'text-gray-600'}`}>
            {charCount}/280
          </span>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-xs bg-gray-900 text-gray-400 rounded-lg hover:bg-gray-800 hover:text-white transition flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
            </svg>
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
