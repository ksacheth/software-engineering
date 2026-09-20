import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import type { Target } from "@/services/targets";

/**
 * The legal attestation, as it was recorded (F.2).
 *
 * A card of its own, beside the verified IP set and the scope editor, because
 * it reports one column and reports it verbatim.
 *
 * What it says used to be a constant: "Acknowledged", whatever the row held.
 * Registration only accepts `authorisationAck: true`, so the two agree today,
 * but the scannable verdict still lists AUTHORISATION_NOT_ACKNOWLEDGED among
 * its reasons, which is the product saying a target can exist without one.
 * Stating the claim regardless would have the page vouch for a legal record
 * that is not there, and F.2 records the attestation once and never lets it be
 * edited, so a user who noticed could not put it right.
 */
export function AuthorisationAckCard({ target }: { target: Target }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" />
          Authorisation Acknowledgement
        </CardTitle>
        <CardDescription>
          Recorded legal attestation of authority to scan this target.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex justify-between py-1.5 border-b border-border text-sm">
          <span className="text-muted-foreground">Attestation</span>
          {target.authorisationAck ? (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              Acknowledged
            </span>
          ) : (
            <span className="font-medium text-destructive">
              Not acknowledged
            </span>
          )}
        </div>

        <div className="flex justify-between py-1.5 border-b border-border text-sm">
          <span className="text-muted-foreground">Attested At</span>
          <span className="text-xs font-mono">
            {target.authorisationAckAt
              ? new Date(target.authorisationAckAt).toLocaleString()
              : "—"}
          </span>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed pt-1">
          {target.authorisationAck
            ? "The user has legally attested that they own or have written permission from the owner to conduct security tests against this target, and acknowledged that unauthorised scanning is a criminal offence. Recorded once at registration and not editable."
            : "No attestation of authority to scan this target is on record. Per C.2 the target is not scannable, and the attestation is recorded at registration and cannot be added afterwards."}
        </p>
      </CardContent>
    </Card>
  );
}
