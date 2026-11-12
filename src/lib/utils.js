import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and resolve Tailwind conflicts, so a caller's
 * `className` always wins over a component's defaults.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
