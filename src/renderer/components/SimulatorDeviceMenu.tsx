import { Fragment, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuChevronDown as ChevronDown, LuSmartphone as Smartphone, LuTablet as Tablet } from "react-icons/lu";
import { simulatorGroups, type SimulatorAvailability, type SimulatorDevice } from "../../domain/simulator";
import { useDismissibleLayer } from "../focus";
import { useAnchoredStyle } from "./BranchMenu";
import { useCommandControls } from "./CommandControl";
import { PickerOption, PickerPopover, PickerSearch } from "./Picker";

const DEVICE_MENU = "simulator-device";
/** Wide enough for the longest iPad name beside its state. */
const MENU_WIDTH = 320;

function DeviceIcon({ name }: { name: string }) {
  return name.startsWith("iPad") ? <Tablet size={16} aria-hidden="true" /> : <Smartphone size={16} aria-hidden="true" />;
}

function DeviceList({ devices, empty, selected, anchor, menuRef, onPick }: {
  devices: SimulatorDevice[];
  /** What an empty list says: why there are no devices here. */
  empty: string;
  selected: string | null;
  anchor: HTMLElement | null;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onPick: (udid: string) => void;
}) {
  const [query, setQuery] = useState("");
  const anchored = useAnchoredStyle(anchor, MENU_WIDTH, MENU_WIDTH);
  const groups = simulatorGroups(devices, query);
  const top = groups[0]?.devices[0];
  return createPortal(
    <PickerPopover
      ref={menuRef}
      className="simulator-device-popover"
      style={anchored ?? { visibility: "hidden" }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || !query || (event.target as HTMLElement).tagName !== "INPUT") return;
        event.preventDefault();
        setQuery("");
      }}
    >
      <PickerSearch label="Search simulators" value={query} onChange={setQuery} onSubmit={() => { if (top) onPick(top.udid); }} />
      <div role="listbox" aria-label="Simulators">
        {!groups.length && <p className="simulator-device-empty" role="status">{devices.length ? "No simulator matches" : empty}</p>}
        {groups.map((group) => (
          <Fragment key={group.label}>
            <p className="simulator-device-group">{group.label}</p>
            {group.devices.map((device) => (
              <PickerOption key={device.udid} selected={device.udid === selected} onClick={() => onPick(device.udid)}>
                <DeviceIcon name={device.name} />
                <span className="simulator-device-name">{device.name}</span>
                {group.running
                  ? <small className={`simulator-device-state ${device.state}`}>{device.state === "booted" ? "Running" : "Starting"} · {device.runtime}</small>
                  : null}
              </PickerOption>
            ))}
          </Fragment>
        ))}
      </div>
    </PickerPopover>,
    document.body,
  );
}

/** Which simulator the panel shows, picked from every iOS device this Mac has, running ones first. */
export function SimulatorDeviceMenu({ devices, availability, selected, openMenu, onSetOpenMenu }: {
  devices: SimulatorDevice[];
  availability: SimulatorAvailability;
  selected: SimulatorDevice | undefined;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
}) {
  const open = openMenu === DEVICE_MENU;
  const controls = useCommandControls();
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  return (
    <div ref={row} className={`simulator-device-menu ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <button
        ref={trigger}
        type="button"
        className="simulator-device-trigger"
        aria-label={selected ? `Simulator: ${selected.name}, ${selected.runtime}` : "Choose a simulator"}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => onSetOpenMenu(open ? null : DEVICE_MENU)}
      >
        <DeviceIcon name={selected?.name ?? ""} />
        <span>{selected?.name ?? "Simulator"}</span>
        {selected && <small>{selected.runtime}</small>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <DeviceList
          devices={devices}
          empty={availability.status === "unsupported" ? availability.reason : availability.status === "unknown" ? "Looking for simulators…" : "No simulators. Add one in Xcode."}
          selected={selected?.udid ?? null}
          anchor={row.current}
          menuRef={menu}
          onPick={(udid) => {
            onSetOpenMenu(null);
            controls.dispatch({ type: "simulator.select", udid });
          }}
        />
      )}
    </div>
  );
}
