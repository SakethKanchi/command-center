import type { ProfileRole } from "@domain";
import { blankProfileRole } from "@domain";
import {
  AddButton,
  EmptyRows,
  RowCard,
  RowControls,
  TextAreaField,
  TextField,
} from "@web/components/profile/FormFields";
import type { FieldErrors } from "@web/lib/profile";
import { moveItem } from "@web/lib/profile";

/**
 * Work history: the section the resume tailoring actually quotes from.
 *
 * Bullets are individually editable and reorderable rather than one textarea
 * of newline-separated lines, because each bullet is the unit the tailoring
 * selects and reorders per posting. A blob of text would force this screen to
 * guess where one claim ends and the next begins, and a wrong guess there is
 * exactly the kind of half-sentence the fabrication gate cannot check.
 *
 * An empty end date is "current", stated in the hint rather than left as a
 * blank the user has to interpret.
 */
export function RolesEditor({
  roles,
  errors,
  onChange,
}: {
  roles: ProfileRole[];
  errors: FieldErrors;
  onChange: (next: ProfileRole[]) => void;
}) {
  const patch = (index: number, change: Partial<ProfileRole>) =>
    onChange(
      roles.map((role, other) =>
        other === index ? { ...role, ...change } : role,
      ),
    );

  return (
    <>
      {roles.length === 0 ? (
        <EmptyRows>
          No roles yet. Most recent first — that is the order a resume reads in.
        </EmptyRows>
      ) : (
        roles.map((role, index) => (
          <RowCard
            // Index-keyed: a role has no id, and keying on its contents would
            // remount the field being typed into. Safe because every field
            // here is controlled.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            title={`Role ${index + 1}`}
            controls={
              <RowControls
                what="role"
                index={index}
                count={roles.length}
                onMove={(from, to) => onChange(moveItem(roles, from, to))}
                onRemove={(at) =>
                  onChange(roles.filter((_, other) => other !== at))
                }
              />
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                path={`roles.${index}.title`}
                label="Title"
                value={role.title}
                placeholder="Senior Backend Engineer"
                autoComplete="organization-title"
                error={errors[`roles.${index}.title`]}
                onChange={(value) => patch(index, { title: value })}
              />
              <TextField
                path={`roles.${index}.company`}
                label="Company"
                value={role.company}
                placeholder="Monzo"
                autoComplete="organization"
                error={errors[`roles.${index}.company`]}
                onChange={(value) => patch(index, { company: value })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                path={`roles.${index}.location`}
                label="Location"
                value={role.location}
                placeholder="Toronto, Canada"
                autoComplete="address-level2"
                onChange={(value) =>
                  patch(index, { location: value === "" ? null : value })
                }
              />
              <TextField
                path={`roles.${index}.startDate`}
                label="Start"
                value={role.startDate}
                placeholder="2024-03"
                onChange={(value) =>
                  patch(index, { startDate: value === "" ? null : value })
                }
              />
              <TextField
                path={`roles.${index}.endDate`}
                label="End"
                value={role.endDate}
                placeholder="2026-01"
                hint="Leave empty for current."
                onChange={(value) =>
                  patch(index, { endDate: value === "" ? null : value })
                }
              />
            </div>

            <fieldset>
              <legend className="u-mono text-[11px] text-ink-faint">
                Bullets
              </legend>
              <div className="mt-1.5 flex flex-col gap-2">
                {role.bullets.length === 0 ? (
                  <EmptyRows>
                    No bullets yet. One accomplishment each, with the number if
                    there is one.
                  </EmptyRows>
                ) : (
                  role.bullets.map((bullet, bulletIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: controlled textarea, no bullet id
                    <div key={bulletIndex} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <TextAreaField
                          path={`roles.${index}.bullets.${bulletIndex}`}
                          label={`Bullet ${bulletIndex + 1}`}
                          rows={2}
                          value={bullet}
                          placeholder="Cut checkout p99 from 840ms to 210ms by…"
                          onChange={(value) =>
                            patch(index, {
                              bullets: role.bullets.map((entry, other) =>
                                other === bulletIndex ? value : entry,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="pt-5">
                        <RowControls
                          what="bullet"
                          index={bulletIndex}
                          count={role.bullets.length}
                          onMove={(from, to) =>
                            patch(index, {
                              bullets: moveItem(role.bullets, from, to),
                            })
                          }
                          onRemove={(at) =>
                            patch(index, {
                              bullets: role.bullets.filter(
                                (_, other) => other !== at,
                              ),
                            })
                          }
                        />
                      </div>
                    </div>
                  ))
                )}
                <div>
                  <AddButton
                    label="Add bullet"
                    onClick={() =>
                      patch(index, { bullets: [...role.bullets, ""] })
                    }
                  />
                </div>
              </div>
            </fieldset>
          </RowCard>
        ))
      )}
      <div>
        <AddButton
          label="Add role"
          onClick={() => onChange([...roles, blankProfileRole()])}
        />
      </div>
    </>
  );
}
