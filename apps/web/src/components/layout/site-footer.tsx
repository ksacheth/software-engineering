import { ShieldAlert } from 'lucide-react';

const PROJECT_TITLE = 'Website Vulnerability Scanner';

const TEAM = [
  { name: 'Deepthi', regNo: '241IT021' },
  { name: 'Jasmine', regNo: '241IT051' },
  { name: 'Koushal', regNo: '241IT058' },
];

const COURSE_INSTRUCTOR = 'Prof. Jaidhar C.D';

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 text-sm">
        <div className="grid gap-6 sm:grid-cols-[2fr_1.5fr_1fr]">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldAlert className="size-5 text-primary" />
              <span>{PROJECT_TITLE}</span>
            </div>
            <p className="text-muted-foreground">
              Developed as part of the Software Engineering course project.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-medium">Project Team</h2>
            <ul className="flex flex-col gap-1">
              {TEAM.map((member) => (
                <li key={member.regNo} className="flex justify-between gap-6 text-muted-foreground">
                  <span>{member.name}</span>
                  <span className="tabular-nums">{member.regNo}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-medium">Course Instructor</h2>
            <p className="text-muted-foreground">{COURSE_INSTRUCTOR}</p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">&copy; 2026 {PROJECT_TITLE}</p>
      </div>
    </footer>
  );
}
