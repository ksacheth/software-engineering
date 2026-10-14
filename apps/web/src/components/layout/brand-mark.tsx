import { ShieldAlert } from 'lucide-react';

/**
 * The product mark: the shield on a brand tile, with the short name and, on
 * wide screens, the full one. Shared by the dashboard and the landing page so
 * the two headers read as the same product.
 */
export function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <ShieldAlert className="size-5" aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-semibold">WVS</span>
        <span className="hidden text-xs text-muted-foreground lg:block">
          Website Vulnerability Scanner
        </span>
      </span>
    </span>
  );
}
