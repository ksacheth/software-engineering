/**
 * The landing hero's picture of a scan: a website under a sweeping scan line,
 * the ownership check it passed, and the findings it produced. Decorative, so
 * hidden from assistive technology; the hero text already says all of this.
 *
 * Colours are the DBIM palette from index.css, written out because SVG fills
 * here sit on the brand gradient rather than on a theme surface.
 */

const FINDINGS = [
  {
    y: 290,
    colour: "#dc3545",
    severity: "Critical",
    text: "Exposed .git directory",
  },
  { y: 318, colour: "#fd7e14", severity: "High", text: "Reflected XSS in ?q" },
  { y: 346, colour: "#ffc107", severity: "Medium", text: "Missing CSP header" },
];

export function HeroIllustration() {
  return (
    <svg
      viewBox="0 0 460 380"
      className="h-auto w-full"
      aria-hidden="true"
      focusable="false"
    >
      <Definitions />
      <BrowserWindow />
      <ScanLine />
      <VerifiedBadge />
      <FindingsCard />
    </svg>
  );
}

/** A translucent white block, the unit the page mock-up is drawn from. */
function Block({
  x,
  y,
  width,
  height,
  rx = 4,
  opacity = 0.15,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
  opacity?: number;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={rx}
      fill="#fff"
      fillOpacity={opacity}
    />
  );
}

/** [x, y, width] for each line of placeholder text on the page. */
const TEXT_LINES = [
  [34, 100, 330],
  [34, 116, 290],
  [34, 132, 310],
  [200, 160, 170],
  [200, 176, 140],
  [200, 192, 160],
];

function Definitions() {
  return (
    <defs>
      <linearGradient id="hero-scan-glow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#6ea8fe" stopOpacity="0" />
        <stop offset="1" stopColor="#6ea8fe" stopOpacity="0.35" />
      </linearGradient>
      <filter
        id="hero-card-shadow"
        x="-20%"
        y="-20%"
        width="140%"
        height="150%"
      >
        <feDropShadow
          dx="0"
          dy="10"
          stdDeviation="12"
          floodColor="#0b1a3d"
          floodOpacity="0.35"
        />
      </filter>
      <clipPath id="hero-page">
        <rect x="10" y="57" width="400" height="243" />
      </clipPath>
    </defs>
  );
}

/** The website: a browser window with a page inside. */
function BrowserWindow() {
  return (
    <g>
      <rect
        x="10"
        y="20"
        width="400"
        height="280"
        rx="14"
        fill="#fff"
        fillOpacity="0.08"
        stroke="#fff"
        strokeOpacity="0.25"
      />
      <line
        x1="10"
        y1="56"
        x2="410"
        y2="56"
        stroke="#fff"
        strokeOpacity="0.2"
      />
      {[34, 52, 70].map((cx) => (
        <circle key={cx} cx={cx} cy="38" r="5" fill="#fff" fillOpacity="0.35" />
      ))}
      <Block x={90} y={29} width={290} height={18} rx={9} opacity={0.12} />
      <Block x={101} y={36} width={8} height={7} rx={1.5} opacity={0.7} />
      <path
        d="M102.5 36v-2a2.5 2.5 0 0 1 5 0v2"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="1.4"
      />
      <text x="116" y="42" fontSize="11" fill="#fff" fillOpacity="0.8">
        https://your-site.example
      </text>

      <Block x={34} y={76} width={200} height={14} opacity={0.3} />
      {TEXT_LINES.map(([x, y, width]) => (
        <Block key={`${x}-${y}`} x={x!} y={y!} width={width!} height={8} />
      ))}
      <Block x={34} y={156} width={150} height={96} rx={8} opacity={0.1} />
      <path
        d="M52 236l30-34 22 22 14-14 28 26z"
        fill="#fff"
        fillOpacity="0.18"
      />
      <circle cx="150" cy="182" r="9" fill="#fff" fillOpacity="0.18" />
      <Block x={200} y={210} width={90} height={22} rx={6} opacity={0.25} />
    </g>
  );
}

/** The scan line sweeping the page; animated from index.css. */
function ScanLine() {
  return (
    <g clipPath="url(#hero-page)">
      <g className="hero-scan">
        <rect
          x="10"
          y="20"
          width="400"
          height="40"
          fill="url(#hero-scan-glow)"
        />
        <rect x="10" y="58" width="400" height="2" fill="#6ea8fe" />
      </g>
    </g>
  );
}

/** Ownership verified before the first request. */
function VerifiedBadge() {
  return (
    <g>
      <circle
        cx="410"
        cy="78"
        r="26"
        fill="#198754"
        stroke="#fff"
        strokeWidth="3"
      />
      <path
        d="M399 78l7 7 14-15"
        fill="none"
        stroke="#fff"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="372" y="110" width="76" height="22" rx="11" fill="#fff" />
      <text
        x="410"
        y="125"
        fontSize="11"
        fontWeight="600"
        fill="#146c43"
        textAnchor="middle"
      >
        Verified
      </text>
    </g>
  );
}

/** What the scan found. */
function FindingsCard() {
  return (
    <g>
      <g filter="url(#hero-card-shadow)">
        <rect x="200" y="240" width="250" height="130" rx="12" fill="#fff" />
      </g>
      <text x="218" y="266" fontSize="13" fontWeight="700" fill="#162f6a">
        Findings
      </text>
      <rect x="386" y="253" width="48" height="18" rx="9" fill="#d2dfff" />
      <text
        x="410"
        y="266"
        fontSize="10"
        fontWeight="600"
        fill="#162f6a"
        textAnchor="middle"
      >
        3 new
      </text>
      {FINDINGS.map(({ y, colour, severity, text }, index) => (
        <g key={severity}>
          {index > 0 && (
            <line x1="218" y1={y - 14} x2="434" y2={y - 14} stroke="#e5e7eb" />
          )}
          <circle cx="223" cy={y - 4} r="5" fill={colour} />
          <text x="234" y={y} fontSize="11" fontWeight="700" fill="#150202">
            {severity}
          </text>
          <text x="290" y={y} fontSize="11" fill="#606060">
            {text}
          </text>
        </g>
      ))}
    </g>
  );
}
