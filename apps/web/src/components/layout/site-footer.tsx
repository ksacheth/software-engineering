import { ShieldAlert } from 'lucide-react';

const PROJECT_TITLE = 'Website Vulnerability Scanner';

const TEAM = [
  { name: 'Deepthi', regNo: '241IT021' },
  { name: 'Jasmine', regNo: '241IT051' },
  { name: 'Koushal', regNo: '241IT058' },
];

const COURSE_INSTRUCTOR = 'Prof. Jaidhar C.D';

// DBIM requires the footer in the key (darkest) shade of the colour group.
export function SiteFooter() {
  return (
    <footer className="bg-brand-900 text-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 text-sm">
        <div className="grid gap-6 sm:grid-cols-[2fr_1.5fr_1fr]">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldAlert className="size-5" />
              <span>{PROJECT_TITLE}</span>
            </div>
            <p className="text-brand-100">
              Developed as part of the Software Engineering course project.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-medium">Project Team</h2>
            <ul className="flex flex-col gap-1">
              {TEAM.map((member) => (
                <li key={member.regNo} className="flex justify-between gap-6 text-brand-100">
                  <span>{member.name}</span>
                  <span className="tabular-nums">{member.regNo}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="font-medium">Course Instructor</h2>
            <p className="text-brand-100">{COURSE_INSTRUCTOR}</p>
          </div>
        </div>

        <p className="text-xs text-brand-100">&copy; 2026 {PROJECT_TITLE}</p>
      </div>
    </footer>
  );
}
