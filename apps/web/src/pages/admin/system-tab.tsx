import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonX, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  engageKillSwitch,
  fetchHealth,
  fetchKillSwitch,
  releaseKillSwitch,
  type Health,
  type KillSwitch,
} from "@/services/admin";
import { ReasonDialog } from "./components/reason-dialog";
import { describeError, QueryError } from "./components/query-error";

/**
 * The kill switch and system health (F.8, ADR-0008).
 */

export function SystemTab() {
  const killSwitch = useQuery({
    queryKey: ["admin", "kill-switch"],
    queryFn: fetchKillSwitch,
  });

  if (killSwitch.error) return <QueryError error={killSwitch.error} />;
  if (!killSwitch.data) return <Spinner aria-label="Loading" />;

  return (
    <div className="flex flex-col gap-6">
      <KillSwitchCard killSwitch={killSwitch.data.killSwitch} />
      <HealthCard />
    </div>
  );
}

function KillSwitchCard({ killSwitch }: { killSwitch: KillSwitch }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const settle = () => {
    setOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    void queryClient.invalidateQueries({ queryKey: ["system-status"] });
    void queryClient.invalidateQueries({ queryKey: ["scans"] });
  };

  const engage = useMutation({
    mutationFn: (reason: string) => engageKillSwitch(reason),
    onSuccess: ({ abortedScans }) => {
      settle();
      toast.success(
        `Kill switch engaged. ${abortedScans} scan${abortedScans === 1 ? "" : "s"} aborted.`,
      );
    },
  });
  const release = useMutation({
    mutationFn: (reason: string) => releaseKillSwitch(reason),
    onSuccess: () => {
      settle();
      toast.success("Kill switch released. Scans can start again.");
    },
  });
  const active = killSwitch.engaged ? release : engage;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {killSwitch.engaged ? "Scanning is halted" : "Scanning is running"}
          <Badge variant={killSwitch.engaged ? "destructive" : "secondary"}>
            {killSwitch.engaged ? "Kill switch engaged" : "Normal"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {killSwitch.engaged ? (
            <>
              Engaged
              {killSwitch.changedBy && <> by {killSwitch.changedBy.email}</>}
              {killSwitch.changedAt && (
                <> at {new Date(killSwitch.changedAt).toLocaleString()}</>
              )}
              {killSwitch.reason && <>: “{killSwitch.reason}”</>}. No scan can
              start, resume or send a request until it is released.
            </>
          ) : (
            <>
              Engaging the kill switch aborts every queued, running and paused
              scan in every organisation, and refuses new ones until it is
              released. Releasing it restarts nothing.
            </>
          )}
        </CardDescription>
        <CardAction>
          <Button
            variant={killSwitch.engaged ? "outline" : "destructive"}
            onClick={() => {
              active.reset();
              setOpen(true);
            }}
          >
            {killSwitch.engaged ? (
              <Play data-icon="inline-start" />
            ) : (
              <OctagonX data-icon="inline-start" />
            )}
            {killSwitch.engaged ? "Release kill switch" : "Engage kill switch"}
          </Button>
        </CardAction>
      </CardHeader>

      {killSwitch.engaged ? (
        <ReasonDialog
          open={open}
          onOpenChange={setOpen}
          title="Release the kill switch?"
          description="Scans can be started again. Nothing that was aborted restarts on its own."
          confirmLabel="Release"
          pending={release.isPending}
          error={release.error ? describeError(release.error) : null}
          onConfirm={(reason) => release.mutate(reason)}
        />
      ) : (
        <ReasonDialog
          open={open}
          onOpenChange={setOpen}
          title="Halt every scan in the deployment?"
          description="Every queued, running and paused scan in every organisation is aborted and cannot be resumed. Say why: the audit log is how anyone will find out later."
          confirmLabel="Halt all scans"
          confirmPhrase="HALT"
          destructive
          pending={engage.isPending}
          error={engage.error ? describeError(engage.error) : null}
          onConfirm={(reason) => engage.mutate(reason)}
        />
      )}
    </Card>
  );
}

type ProbeResult = Health[keyof Health];

function isFailure(probe: ProbeResult): probe is { ok: false; error: string } {
  return "ok" in probe && probe.ok === false;
}

function ProbeRow({
  id,
  label,
  probe,
  render,
}: {
  id: string;
  label: string;
  probe: ProbeResult;
  render?: () => string;
}) {
  const failed = isFailure(probe);
  return (
    <div
      data-testid={`health-${id}`}
      className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-0"
    >
      <span className="font-medium">{label}</span>
      <span className="flex items-center gap-2 text-right">
        <Badge variant={failed ? "destructive" : "secondary"}>
          {failed ? "Unavailable" : "OK"}
        </Badge>
        <span className="text-muted-foreground">
          {failed ? probe.error : render?.()}
        </span>
      </span>
    </div>
  );
}

function HealthCard() {
  const health = useQuery({
    queryKey: ["admin", "health"],
    queryFn: fetchHealth,
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>System health</CardTitle>
        <CardDescription>
          Refreshed every 15 seconds. Each check reports on its own, so one
          failure does not hide the others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {health.error && <QueryError error={health.error} />}
        {!health.data && !health.error && <Spinner aria-label="Loading" />}
        {health.data && <HealthRows health={health.data} />}
      </CardContent>
    </Card>
  );
}

function HealthRows({ health }: { health: Health }) {
  const { queue, scans, email } = health;
  return (
    <div>
      <ProbeRow id="database" label="Database" probe={health.database} />
      <ProbeRow id="redis" label="Redis" probe={health.redis} />
      <ProbeRow
        id="queue"
        label="Scan queue"
        probe={queue}
        render={() =>
          isFailure(queue)
            ? ""
            : `${queue.waiting} waiting · ${queue.active} active · ${queue.failed} failed`
        }
      />
      <ProbeRow
        id="scans"
        label="Active scans"
        probe={scans}
        render={() =>
          isFailure(scans)
            ? ""
            : Object.entries(scans)
                .map(([status, count]) => `${count} ${status.toLowerCase()}`)
                .join(" · ")
        }
      />
      <ProbeRow
        id="email"
        label="Email retry queue"
        probe={email}
        render={() =>
          isFailure(email)
            ? ""
            : `${email.pending} pending · ${email.deadLettered} dead-lettered${
                email.oldestPendingAt
                  ? ` · oldest ${new Date(email.oldestPendingAt).toLocaleString()}`
                  : ""
              }`
        }
      />
    </div>
  );
}
