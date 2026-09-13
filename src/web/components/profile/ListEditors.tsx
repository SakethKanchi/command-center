import type { ProfileEducation, ProfileLink, SkillGroup } from "@domain";
import { blankProfileEducation } from "@domain";
import {
  AddButton,
  EmptyRows,
  RowCard,
  RowControls,
  TextField,
} from "@web/components/profile/FormFields";
import type { FieldErrors } from "@web/lib/profile";
import { moveItem } from "@web/lib/profile";

/**
 * The three flat repeated lists. Roles are in their own file because they nest
 * a second list; these do not, so they share one shape: a card per entry, its
 * own reorder and remove buttons, and an add button under the last one.
 *
 * Order is data, not presentation — a resume is read top to bottom — so every
 * list is reorderable rather than sorted for the user.
 */

export function LinksEditor({
  links,
  errors,
  onChange,
}: {
  links: ProfileLink[];
  errors: FieldErrors;
  onChange: (next: ProfileLink[]) => void;
}) {
  return (
    <>
      {links.length === 0 ? (
        <EmptyRows>
          No links yet. A portfolio, a GitHub profile or a LinkedIn URL.
        </EmptyRows>
      ) : (
        links.map((link, index) => (
          <RowCard
            // Index-keyed on purpose: a link has no id, and keying on its
            // content would remount the input being typed into on every
            // keystroke, losing the caret. Safe because every field is
            // controlled, so a reorder moves values, not DOM state.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            title={`Link ${index + 1}`}
            controls={
              <RowControls
                what="link"
                index={index}
                count={links.length}
                onMove={(from, to) => onChange(moveItem(links, from, to))}
                onRemove={(at) =>
                  onChange(links.filter((_, other) => other !== at))
                }
              />
            }
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_1fr]">
              <TextField
                path={`links.${index}.label`}
                label="Label"
                value={link.label}
                placeholder="GitHub"
                error={errors[`links.${index}.label`]}
                onChange={(value) =>
                  onChange(
                    links.map((entry, other) =>
                      other === index ? { ...entry, label: value } : entry,
                    ),
                  )
                }
              />
              <TextField
                path={`links.${index}.url`}
                label="URL"
                type="url"
                inputMode="url"
                autoComplete="url"
                value={link.url}
                placeholder="https://github.com/you"
                error={errors[`links.${index}.url`]}
                onChange={(value) =>
                  onChange(
                    links.map((entry, other) =>
                      other === index ? { ...entry, url: value } : entry,
                    ),
                  )
                }
              />
            </div>
          </RowCard>
        ))
      )}
      <div>
        <AddButton
          label="Add link"
          onClick={() => onChange([...links, { label: "", url: "" }])}
        />
      </div>
    </>
  );
}

export function SkillsEditor({
  skills,
  errors,
  onChange,
}: {
  skills: SkillGroup[];
  errors: FieldErrors;
  onChange: (next: SkillGroup[]) => void;
}) {
  return (
    <>
      {skills.length === 0 ? (
        <EmptyRows>
          No skill groups yet. Group them the way a reader scans them —
          “Languages”, “Infrastructure”.
        </EmptyRows>
      ) : (
        skills.map((group, index) => (
          <RowCard
            // biome-ignore lint/suspicious/noArrayIndexKey: controlled fields, no row id — see LinksEditor
            key={index}
            title={`Group ${index + 1}`}
            controls={
              <RowControls
                what="skill group"
                index={index}
                count={skills.length}
                onMove={(from, to) => onChange(moveItem(skills, from, to))}
                onRemove={(at) =>
                  onChange(skills.filter((_, other) => other !== at))
                }
              />
            }
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
              <TextField
                path={`skills.${index}.name`}
                label="Group"
                value={group.name}
                placeholder="Languages"
                error={errors[`skills.${index}.name`]}
                onChange={(value) =>
                  onChange(
                    skills.map((entry, other) =>
                      other === index ? { ...entry, name: value } : entry,
                    ),
                  )
                }
              />
              {/*
               * Comma-separated, kept as typed until blur would be the tidy
               * choice, but it would also swallow a trailing comma mid-thought.
               * Splitting on every change keeps the field and the model in
               * step; the empty-segment filter is what makes "a, b," behave.
               */}
              <TextField
                path={`skills.${index}.keywords`}
                label="Keywords"
                value={group.keywords.join(", ")}
                placeholder="TypeScript, Go, SQL"
                hint="Comma separated."
                onChange={(value) =>
                  onChange(
                    skills.map((entry, other) =>
                      other === index
                        ? {
                            ...entry,
                            keywords: value
                              .split(",")
                              .map((word) => word.trim())
                              .filter((word) => word !== ""),
                          }
                        : entry,
                    ),
                  )
                }
              />
            </div>
          </RowCard>
        ))
      )}
      <div>
        <AddButton
          label="Add skill group"
          onClick={() => onChange([...skills, { name: "", keywords: [] }])}
        />
      </div>
    </>
  );
}

export function EducationEditor({
  education,
  errors,
  onChange,
}: {
  education: ProfileEducation[];
  errors: FieldErrors;
  onChange: (next: ProfileEducation[]) => void;
}) {
  const patch = (index: number, change: Partial<ProfileEducation>) =>
    onChange(
      education.map((entry, other) =>
        other === index ? { ...entry, ...change } : entry,
      ),
    );

  return (
    <>
      {education.length === 0 ? (
        <EmptyRows>No education entries yet.</EmptyRows>
      ) : (
        education.map((entry, index) => (
          <RowCard
            // biome-ignore lint/suspicious/noArrayIndexKey: controlled fields, no row id — see LinksEditor
            key={index}
            title={`Entry ${index + 1}`}
            controls={
              <RowControls
                what="education entry"
                index={index}
                count={education.length}
                onMove={(from, to) => onChange(moveItem(education, from, to))}
                onRemove={(at) =>
                  onChange(education.filter((_, other) => other !== at))
                }
              />
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                path={`education.${index}.school`}
                label="School"
                value={entry.school}
                placeholder="University of Waterloo"
                error={errors[`education.${index}.school`]}
                onChange={(value) => patch(index, { school: value })}
              />
              <TextField
                path={`education.${index}.credential`}
                label="Credential"
                value={entry.credential}
                placeholder="BASc, Computer Engineering"
                onChange={(value) =>
                  patch(index, { credential: value === "" ? null : value })
                }
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                path={`education.${index}.location`}
                label="Location"
                value={entry.location}
                placeholder="Waterloo, Canada"
                autoComplete="address-level2"
                onChange={(value) =>
                  patch(index, { location: value === "" ? null : value })
                }
              />
              <TextField
                path={`education.${index}.startDate`}
                label="Start"
                value={entry.startDate}
                placeholder="2018-09"
                onChange={(value) =>
                  patch(index, { startDate: value === "" ? null : value })
                }
              />
              <TextField
                path={`education.${index}.endDate`}
                label="End"
                value={entry.endDate}
                placeholder="2023-04"
                onChange={(value) =>
                  patch(index, { endDate: value === "" ? null : value })
                }
              />
            </div>
          </RowCard>
        ))
      )}
      <div>
        <AddButton
          label="Add education"
          onClick={() => onChange([...education, blankProfileEducation()])}
        />
      </div>
    </>
  );
}
