import { useQuery } from "@tanstack/react-query";
import { fetchSystemStatus } from "@/services/system";

/**
 * Whether an administrator has halted scanning (F.8, ADR-0008).
 *
 * Polled rather than pushed: the switch is rare and the API refuses a start or
 * resume while it is engaged whatever this says, so a stale answer costs one
 * refused click, not a scan. Disabling the controls is a courtesy.
 */
const POLL_MS = 30_000;

export function useKillSwitchEngaged(): boolean {
  const { data } = useQuery({
    queryKey: ["system-status"],
    queryFn: fetchSystemStatus,
    refetchInterval: POLL_MS,
  });
  return data?.killSwitch.engaged ?? false;
}
