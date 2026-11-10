import { useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { settingControl, type SettingId } from "../../domain/settings-catalog";
import { useSettingMark } from "./SettingRow";

export type SettingsPageProps = {
  title: ReactNode;
  description?: ReactNode;
  /** One action over every section of the page, beside its title. */
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
};

/** A settings page: its title, what it is for, and its sections. */
export function SettingsPage({ title, description, action, className, children }: SettingsPageProps) {
  return (
    <main className={className ? `settings-main ${className}` : "settings-main"}>
      <div className={action ? "settings-page-heading with-action" : "settings-page-heading"}>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="settings-group-action">{action}</div>}
      </div>
      {children}
    </main>
  );
}

export type SettingsSectionProps = Omit<ComponentPropsWithRef<"section">, "title"> & {
  /** The catalog entry a search can land on the whole section by. It names the section unless `title` does. */
  setting?: SettingId;
  title?: ReactNode;
  description?: ReactNode;
  /** Drawn under the description, as given. */
  detail?: ReactNode;
  /** A status mark at the heading's trailing edge. */
  badge?: ReactNode;
  /** The section's controls, at the heading's trailing edge. */
  action?: ReactNode;
};

/** A titled group of rows on a settings page. */
export function SettingsSection({ setting, title, description, detail, badge, action, className, children, ref, ...section }: SettingsSectionProps) {
  const heading = useId();
  const landing = useSettingMark<HTMLElement>(setting ?? "");
  const attach = (element: HTMLElement | null) => {
    landing.ref.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };
  const classes = ["settings-group", landing.found && "found", className].filter(Boolean).join(" ");
  const name = title ?? (setting && settingControl(setting).label);
  return (
    <section aria-labelledby={name ? heading : undefined} {...section} ref={attach} className={classes} data-setting={setting}>
      <div className="settings-group-heading">
        <div>
          {name && <h3 id={heading}>{name}</h3>}
          {description && <p>{description}</p>}
          {detail}
        </div>
        {badge}
        {action && <div className="settings-group-action">{action}</div>}
      </div>
      {children}
    </section>
  );
}
