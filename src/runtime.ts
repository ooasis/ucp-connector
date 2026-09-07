/** Which runtime this code is executing in (Node service vs Cloudflare Worker). */
export const IS_WORKERS =
  typeof navigator !== 'undefined' && (navigator as any).userAgent === 'Cloudflare-Workers';
