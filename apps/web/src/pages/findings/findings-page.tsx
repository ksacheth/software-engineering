import { FindingsTable } from "./components/findings-table";

/**
 * The current posture (F.6): each target's findings from its most recent
 * completed scan. A single scan's findings live on that scan's page.
 */
export function FindingsPage() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Findings</h1>
        <p className="text-sm text-muted-foreground">
          What the latest completed scan of each target found, most urgent
          first.
        </p>
      </div>
      <FindingsTable />
    </div>
  );
}
