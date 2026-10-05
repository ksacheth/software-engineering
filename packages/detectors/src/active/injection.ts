import type { Observation } from "../types";
import type { ActiveContext, ActiveDetector } from "./types";
import { targetFor, withParameter } from "./probe-helpers";

/**
 * A-01..A-03, A-11, A-12: one benign probe per query parameter. Each sends a
 * recognisable but inert value and judges the reply; none changes server
 * state, and all use GET, the only method the guard permits here (F.5).
 */
async function perParameter(
  context: ActiveContext,
  probe: (context: ActiveContext, parameter: string, target: string) => Promise<Observation | null>,
): Promise<Observation[]> {
  const { parameters, entryUrls, origin } = context.surface;
  const observations: Observation[] = [];
  for (const parameter of parameters) {
    const observation = await probe(context, parameter, targetFor(parameter, entryUrls, origin));
    if (observation) observations.push(observation);
  }
  return observations;
}

/** Characters that must be encoded in HTML; if the marker returns wrapped in
 *  them, output is not being encoded for its context. */
const HTML_SIGNIFICANT = "'\"<>";

const a01: ActiveDetector = {
  id: "A-01",
  run: (context) =>
    perParameter(context, async (ctx, parameter, target) => {
      const marker = ctx.marker();
      const probeValue = `${HTML_SIGNIFICANT}${marker}${HTML_SIGNIFICANT}`;
      const response = await ctx.probe({ url: withParameter(target, parameter, probeValue), method: "GET" });
      // Reflected verbatim, angle brackets and quotes intact, means an injected
      // script would survive too. The marker itself does nothing.
      if (!response.ok || !response.body.includes(probeValue)) return null;
      return {
        affectedUrl: withParameter(target, parameter, "<marker>"),
        affectedParameter: parameter,
        detail: `The value of "${parameter}" is reflected into the page without encoding its HTML-significant characters.`,
        evidence: { extractedSnippet: `reflected: ${probeValue}` },
      };
    }),
};

/** A single quote breaks unparameterised SQL; these are the resulting errors. */
const SQL_ERRORS =
  /(SQL syntax|SQLSTATE\[|ORA-\d{5}|PG::\w+Error|SQLite3?::|mysql_fetch|unclosed quotation mark|quoted string not properly terminated)/i;

const a02: ActiveDetector = {
  id: "A-02",
  run: (context) =>
    perParameter(context, async (ctx, parameter, target) => {
      const response = await ctx.probe({ url: withParameter(target, parameter, "'"), method: "GET" });
      if (!response.ok || !SQL_ERRORS.test(response.body)) return null;
      const error = SQL_ERRORS.exec(response.body)![0];
      return {
        affectedUrl: withParameter(target, parameter, "'"),
        affectedParameter: parameter,
        detail: `A syntax-breaking character in "${parameter}" produced a database error (${error}).`,
        evidence: { extractedSnippet: error },
      };
    }),
};

/** Normalises away whitespace and digits so that only structural differences
 *  between the true and false responses remain. */
function shape(body: string): string {
  return body.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

const a03: ActiveDetector = {
  id: "A-03",
  run: (context) =>
    perParameter(context, async (ctx, parameter, target) => {
      // A condition that is always true versus always false. If the parameter
      // reaches a query, the two pages differ in structure, not just in volatile
      // content; a parameter that is ignored yields identical shapes.
      const truthy = await ctx.probe({ url: withParameter(target, parameter, "1 OR 1=1"), method: "GET" });
      const falsy = await ctx.probe({ url: withParameter(target, parameter, "1 AND 1=2"), method: "GET" });
      const control = await ctx.probe({ url: withParameter(target, parameter, "1"), method: "GET" });
      if (!truthy.ok || !falsy.ok || !control.ok) return null;
      const differsByCondition = shape(truthy.body) === shape(control.body) && shape(falsy.body) !== shape(control.body);
      if (!differsByCondition) return null;
      return {
        affectedUrl: withParameter(target, parameter, "<condition>"),
        affectedParameter: parameter,
        detail: `Responses for "${parameter}" change with a true vs false SQL condition, which indicates the value reaches a query.`,
      };
    }),
};

/** The traversal climbs out of the web root to a file every Unix host has and
 *  nothing writes to; the probe only reads, and matches its first line. */
const TRAVERSAL = "../../../../../../etc/passwd";
const PASSWD_SIGNATURE = /root:.*?:0:0:/;

const a11: ActiveDetector = {
  id: "A-11",
  run: (context) =>
    perParameter(context, async (ctx, parameter, target) => {
      const response = await ctx.probe({ url: withParameter(target, parameter, TRAVERSAL), method: "GET" });
      if (!response.ok || !PASSWD_SIGNATURE.test(response.body)) return null;
      return {
        affectedUrl: withParameter(target, parameter, "<traversal>"),
        affectedParameter: parameter,
        detail: `A read-only traversal through "${parameter}" returned the signature of a system file, so file paths are built from user input.`,
        evidence: { extractedSnippet: "matched /etc/passwd signature" },
      };
    }),
};

/** An arithmetic expression only a template engine evaluates; the result, not
 *  the literal, coming back proves evaluation. Detection only, no exploitation. */
const TEMPLATE_PROBES = ["{{71*71}}", "${71*71}", "#{71*71}"];
const TEMPLATE_RESULT = "5041";

const a12: ActiveDetector = {
  id: "A-12",
  run: (context) =>
    perParameter(context, async (ctx, parameter, target) => {
      for (const expression of TEMPLATE_PROBES) {
        const response = await ctx.probe({ url: withParameter(target, parameter, expression), method: "GET" });
        // Require the computed result and the absence of the literal, so a page
        // that merely echoes the input is not mistaken for one that evaluated it.
        if (response.ok && response.body.includes(TEMPLATE_RESULT) && !response.body.includes(expression)) {
          return {
            affectedUrl: withParameter(target, parameter, "<expr>"),
            affectedParameter: parameter,
            detail: `An arithmetic expression in "${parameter}" was evaluated by the server (${expression} became ${TEMPLATE_RESULT}).`,
            evidence: { extractedSnippet: `${expression} -> ${TEMPLATE_RESULT}` },
          };
        }
      }
      return null;
    }),
};

export const INJECTION_DETECTORS: ActiveDetector[] = [a01, a02, a03, a11, a12];
