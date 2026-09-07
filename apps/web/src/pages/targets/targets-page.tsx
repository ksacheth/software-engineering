export function TargetsPage() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Targets</h1>
        <p className="text-muted-foreground">Manage and scan your authorized target domains.</p>
      </div>
      <div className="rounded-lg border border-border bg-card p-8 text-card-foreground shadow-xs">
        <div className="flex flex-col items-center justify-center text-center">
          <p className="text-sm text-muted-foreground">No targets configured yet.</p>
        </div>
      </div>
    </div>
  );
}
