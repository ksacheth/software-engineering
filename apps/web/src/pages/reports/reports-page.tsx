import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GenerateReportDialog } from "./generate-report-dialog";
import { ReportsTable } from "./reports-table";

/**
 * F.7 reports: everything the organisation has generated, newest first.
 * `?scanId=` narrows it to one scan, which is where the ready email links.
 */
export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const scanId = params.get("scanId") ?? undefined;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground">
            Generate, download and share reports for completed scans.
          </p>
        </div>
        <GenerateReportDialog scanId={scanId} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {scanId ? "Reports for one scan" : "All reports"}
          </CardTitle>
          <CardDescription>
            Reports are generated in the background. This list updates as they
            finish, and you are emailed when yours is ready.
          </CardDescription>
          {scanId && (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => setParams({})}
            >
              <X data-icon="inline-start" />
              Show all reports
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <ReportsTable scanId={scanId} />
        </CardContent>
      </Card>
    </div>
  );
}
