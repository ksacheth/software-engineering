import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GenerateReportDialog } from "./generate-report-dialog";
import { ReportsTable } from "./reports-table";

/** One completed scan's reports, with the control to generate another (F.7). */
export function ScanReportsCard({ scanId }: { scanId: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-base">Reports</CardTitle>
          <CardDescription>
            Executive and technical reports of this scan, as PDF, HTML, JSON,
            CSV or SARIF.
          </CardDescription>
        </div>
        <GenerateReportDialog scanId={scanId} />
      </CardHeader>
      <CardContent>
        <ReportsTable scanId={scanId} />
      </CardContent>
    </Card>
  );
}
