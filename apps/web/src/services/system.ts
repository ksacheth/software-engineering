/**
 * What every signed-in user may know about the system (F.8): whether an
 * administrator has halted scanning with the kill switch.
 */

export interface SystemStatus {
  killSwitch: { engaged: boolean };
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await fetch("/api/system/status", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`System status failed with status ${res.status}`);
  }
  return (await res.json()) as SystemStatus;
}
