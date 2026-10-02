import { OctagonX } from 'lucide-react';
import { useKillSwitchEngaged } from '@/lib/use-kill-switch';

/**
 * Shown to every signed-in user while the kill switch is engaged (ADR-0008),
 * so a refused scan is explained before anyone clicks Start.
 */
export function KillSwitchBanner() {
  if (!useKillSwitchEngaged()) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2 text-sm text-destructive"
    >
      <OctagonX className="size-4 shrink-0" />
      <span>
        An administrator has halted all scanning with the kill switch. Scans
        cannot start or resume until it is released.
      </span>
    </div>
  );
}
