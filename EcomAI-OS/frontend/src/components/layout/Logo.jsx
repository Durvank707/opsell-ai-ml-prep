import React from 'react';
import { cn } from '../../lib/utils';

export function Logo({ size = 'md', className, inverse = false }) {
  const sizes = {
    sm: 'h-8 w-8 rounded-lg',
    md: 'h-9 w-9 rounded-xl',
    lg: 'h-11 w-11 rounded-xl',
  };
  return (
    <svg viewBox="0 0 32 32" className={cn(sizes[size], className)} aria-label="EcomAI-OS logo">
      <rect width="32" height="32" rx="8" fill="#4f46e5" />
      <path d="M9 25V7h4.2l7.6 10.2V7H25v18h-4.2L13.2 14.8V25z" fill="#fff" />
      <path d="M10 25h12v1.4H10z" fill="#a5b4fc" />
    </svg>
  );
}

export function Logotype({ light = false }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo />
      <span className={cn('text-[17px] font-extrabold tracking-tight', light ? 'text-white' : 'text-slate-900')}>
        EcomAI<span className="text-brand-600">-OS</span>
      </span>
    </span>
  );
}

const AVATAR_COLORS = [
  'bg-brand-600',
  'bg-emerald-600',
  'bg-rose-500',
  'bg-amber-500',
  'bg-sky-600',
  'bg-violet-600',
];

export function Avatar({ name, className, size = 'md' }) {
  const initials = name
    ?.split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'U';
  const color = AVATAR_COLORS[(initials.charCodeAt(0) + initials.length) % AVATAR_COLORS.length];
  const sizes = {
    sm: 'h-7 w-7 text-[10px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-12 w-12 text-sm',
  };
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white',
        color,
        sizes[size],
        className,
      )}
      aria-hidden
    >
      {initials}
    </span>
  );
}