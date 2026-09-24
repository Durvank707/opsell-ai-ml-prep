import React from 'react';
import { cn } from '../../lib/utils';

const VARIANTS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  'danger-soft': 'btn-danger-soft',
};

const SIZES = {
  sm: 'px-2.5 py-1.5 text-xs rounded-md',
  md: 'px-3.5 py-2 text-sm rounded-lg',
  lg: 'px-5 py-2.5 text-sm rounded-xl',
};

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon: Icon = null,
  children,
  className,
  disabled,
  ...rest
}) {
  return (
    <button
      className={cn(VARIANTS[variant], SIZES[size], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span
          className={cn(
            'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent',
            size === 'sm' && 'h-3 w-3',
          )}
          aria-hidden
        />
      ) : (
        Icon && <Icon className={cn('shrink-0', size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
      )}
      {children}
    </button>
  );
}