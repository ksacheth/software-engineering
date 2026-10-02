import { useNavigate, useParams } from "react-router-dom";
import { ShieldOff } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useRole } from "@/lib/use-role";
import { SystemTab } from "./system-tab";
import { UsersTab } from "./users-tab";
import { OrganizationsTab } from "./organizations-tab";
import { BlocklistTab } from "./blocklist-tab";
import { AuditTab } from "./audit-tab";

/**
 * F.8 administration (ADR-0009).
 *
 * Each section is its own URL, so an administrator can link a colleague
 * straight to the audit log. The role check here only decides what to render;
 * every request behind it is refused by the API for anyone who is not an
 * administrator with two-factor authentication.
 */

const SECTIONS = [
  { value: "system", label: "System", Component: SystemTab },
  { value: "users", label: "Accounts", Component: UsersTab },
  { value: "organizations", label: "Organisations", Component: OrganizationsTab },
  { value: "blocklist", label: "Blocklist", Component: BlocklistTab },
  { value: "audit", label: "Audit log", Component: AuditTab },
] as const;

type Section = (typeof SECTIONS)[number]["value"];

function isSection(value: string): value is Section {
  return SECTIONS.some((section) => section.value === value);
}

export function AdminPage() {
  const role = useRole();
  const navigate = useNavigate();
  const requested = (useParams()["*"] ?? "").replace(/\/+$/, "");
  const section: Section = isSection(requested) ? requested : "system";

  if (role === null) {
    return (
      <div className="flex justify-center p-12">
        <Spinner aria-label="Loading" />
      </div>
    );
  }

  if (role !== "ADMIN") {
    return (
      <Empty className="m-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldOff />
          </EmptyMedia>
          <EmptyTitle>Administrators only</EmptyTitle>
          <EmptyDescription>
            This area manages the whole deployment. Ask an administrator if you
            need something changed here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Administration</h1>
        <p className="text-sm text-muted-foreground">
          The kill switch, accounts, quotas, the network blocklist and the audit
          log, across every organisation.
        </p>
      </div>

      <Tabs
        value={section}
        onValueChange={(value) => navigate(`/admin/${value}`)}
      >
        <TabsList>
          {SECTIONS.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {SECTIONS.map(({ value, Component }) => (
          <TabsContent key={value} value={value} className="pt-4">
            {value === section && <Component />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
