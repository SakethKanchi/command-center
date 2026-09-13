import type { ProfileProject } from "@domain";
import { blankProfileProject } from "@domain";
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
 * Work with no employer attached: side projects, open source, coursework.
 *
 * Shaped like a role rather than like a link, because that is what the
 * tailoring needs from it — a project earns space on a resume through its
 * bullets, and those bullets are quoted and reordered per posting exactly as a
 * role's are. The description is the one line that sits beside the title, and
 * the URL is optional: plenty of real work is not public.
 */
export function ProjectsEditor({
  projects,
  errors,
  onChange,
}: {
  projects: ProfileProject[];
  errors: FieldErrors;
  onChange: (next: ProfileProject[]) => void;
}) {
  const patch = (index: number, change: Partial<ProfileProject>) =>
    onChange(
      projects.map((project, other) =>
        other === index ? { ...project, ...change } : project,
      ),
    );

  return (
    <>
      {projects.length === 0 ? (
        <EmptyRows>
          No projects yet. Strongest first — a project is only worth the space
          it takes from your experience.
        </EmptyRows>
      ) : (
        projects.map((project, index) => (
          <RowCard
            // Index-keyed for the same reason as roles: a project has no id,
            // and every field below is controlled.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            title={`Project ${index + 1}`}
            controls={
              <RowControls
                what="project"
                index={index}
                count={projects.length}
                onMove={(from, to) => onChange(moveItem(projects, from, to))}
                onRemove={(at) =>
                  onChange(projects.filter((_, other) => other !== at))
                }
              />
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                path={`projects.${index}.name`}
                label="Name"
                value={project.name}
                placeholder="ai-quota-tracker"
                error={errors[`projects.${index}.name`]}
                onChange={(value) => patch(index, { name: value })}
              />
              <TextField
                path={`projects.${index}.url`}
                label="Link"
                type="url"
                inputMode="url"
                value={project.url}
                placeholder="https://github.com/ada/ai-quota-tracker"
                hint="Optional. Printed next to the name."
                error={errors[`projects.${index}.url`]}
                onChange={(value) =>
                  patch(index, { url: value === "" ? null : value })
                }
              />
            </div>

            <TextField
              path={`projects.${index}.description`}
              label="Description"
              value={project.description}
              placeholder="Quota telemetry across five AI providers"
              hint="One line, shown beside the name. Often the stack."
              onChange={(value) => patch(index, { description: value })}
            />

            <fieldset>
              <legend className="u-mono text-[11px] text-ink-faint">
                Bullets
              </legend>
              <div className="mt-1.5 flex flex-col gap-2">
                {project.bullets.length === 0 ? (
                  <EmptyRows>
                    No bullets yet. What it does and what it cost you to build
                    it, with the number if there is one.
                  </EmptyRows>
                ) : (
                  project.bullets.map((bullet, bulletIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: controlled textarea, no bullet id
                    <div key={bulletIndex} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <TextAreaField
                          path={`projects.${index}.bullets.${bulletIndex}`}
                          label={`Bullet ${bulletIndex + 1}`}
                          rows={2}
                          value={bullet}
                          placeholder="Polls five provider APIs on one OAuth refresh path…"
                          onChange={(value) =>
                            patch(index, {
                              bullets: project.bullets.map((entry, other) =>
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
                          count={project.bullets.length}
                          onMove={(from, to) =>
                            patch(index, {
                              bullets: moveItem(project.bullets, from, to),
                            })
                          }
                          onRemove={(at) =>
                            patch(index, {
                              bullets: project.bullets.filter(
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
                      patch(index, { bullets: [...project.bullets, ""] })
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
          label="Add project"
          onClick={() => onChange([...projects, blankProfileProject()])}
        />
      </div>
    </>
  );
}
