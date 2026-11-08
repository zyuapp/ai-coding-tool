import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { LuHouse as House, LuLock as Lock, LuSmartphone as Smartphone, LuTriangleAlert as AlertTriangle } from "react-icons/lu";
import { hidUsage, screenCornerRadius, type SimulatorInput, type SimulatorState } from "../../domain/simulator";
import { useSimulatorStream } from "../simulator/use-simulator-stream";
import { CommandButton } from "./CommandControl";
import { PopoverMenu } from "./PopoverMenu";
import { SpinningIcon } from "./SpinningIcon";

const DEVICE_MENU = "simulator-device";

export type SimulatorPanelProps = {
  simulator: SimulatorState;
  /** The device this dock shows. */
  udid: string | null;
  /** Whether the panel is the tab on screen, which is the only time the device's screen is streamed. */
  active: boolean;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onInput: (udid: string, input: SimulatorInput) => void;
};

function Notice({ icon, title, detail, action, tone }: { icon: ReactNode; title: string; detail?: string; action?: ReactNode; tone?: "error" }) {
  return (
    <div className={`simulator-notice ${tone ?? ""}`.trimEnd()} role={tone === "error" ? "alert" : "status"}>
      <span className="agent-orb">{icon}</span>
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}

/** Where on the screen a pointer is, as fractions of it from its top left. */
function position(event: PointerEvent<HTMLCanvasElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
}

export function SimulatorPanel({ simulator, udid, active, openMenu, onSetOpenMenu, onInput }: SimulatorPanelProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pressed = useRef<Set<number>>(new Set());
  const device = simulator.devices.find((item) => item.udid === udid);
  const booted = device?.state === "booted";
  const stream = useSimulatorStream(canvas, active && booted ? device.udid : null);
  const size = stream.error ? null : stream.size;
  const driving = Boolean(device && simulator.driver?.udid === device.udid);
  const error = device ? simulator.errors[device.udid] : undefined;
  const booting = device ? simulator.booting.includes(device.udid) || device.state === "booting" : false;

  const send = (input: SimulatorInput) => { if (device) onInput(device.udid, input); };
  const release = () => {
    for (const usage of pressed.current) send({ kind: "key", usage, down: false });
    pressed.current.clear();
  };

  const onKey = (event: KeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    /** ⌘ keeps meaning the app's own shortcuts, so only typing reaches the device. */
    if (event.metaKey) return;
    const usage = hidUsage(event.code);
    if (usage === undefined) return;
    event.preventDefault();
    if (down && (event.repeat || pressed.current.has(usage))) return;
    if (down) pressed.current.add(usage);
    else if (!pressed.current.delete(usage)) return;
    send({ kind: "key", usage, down });
  };

  const items = simulator.devices.map((item) => ({
    label: item.name,
    detail: item.runtime,
    checked: item.udid === udid,
    command: { type: "simulator.select" as const, udid: item.udid },
  }));

  const screenStyle = size && device ? {
    "--simulator-aspect": `${size.width / size.height}`,
    borderRadius: `${screenCornerRadius(device.name) * 100}% / ${screenCornerRadius(device.name) * 100 * size.width / size.height}%`,
  } as CSSProperties : undefined;

  let body: ReactNode;
  if (simulator.availability.status === "unsupported") {
    body = <Notice icon={<Smartphone size={18} />} title="Simulator unavailable" detail={simulator.availability.reason} />;
  } else if (!device) {
    body = <Notice icon={<SpinningIcon icon={Smartphone} spinning={simulator.availability.status === "unknown"} size={18} />} title={simulator.availability.status === "unknown" ? "Looking for simulators" : "No simulators"} detail={simulator.availability.status === "unknown" ? undefined : "Add an iOS simulator in Xcode, then open this panel again."} />;
  } else if (error && !booting) {
    body = <Notice tone="error" icon={<AlertTriangle size={18} />} title={`${device.name} could not start`} detail={error}
      action={<CommandButton type="button" command={{ type: "simulator.select", udid: device.udid }}>Try again</CommandButton>} />;
  } else if (!booted) {
    body = booting
      ? <Notice icon={<SpinningIcon icon={Smartphone} spinning size={18} />} title={`Starting ${device.name}`} detail="It runs in the background, so you can keep working." />
      : <Notice icon={<Smartphone size={18} />} title={`${device.name} is off`}
        action={<CommandButton type="button" command={{ type: "simulator.select", udid: device.udid }}>Start</CommandButton>} />;
  }

  return (
    <section className="simulator-panel" aria-label="Simulator">
      <header className="simulator-bar">
        <PopoverMenu id={DEVICE_MENU} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} label="Choose a simulator" className="simulator-device-menu" popoverClassName="simulator-device-popover" anchored
          items={items.length ? items : [{ label: "No simulators", disabled: true }]}>
          <Smartphone size={16} aria-hidden="true" />
          <span>{device?.name ?? "Simulator"}</span>
          {device && <small>{device.runtime}</small>}
        </PopoverMenu>
        {driving && <span className="simulator-driving" role="status"><i aria-hidden="true" />Agent is using this device</span>}
        <span className="simulator-bar-gap" />
        {device && (
          <>
            <CommandButton type="button" aria-label="Home" data-tip="Home" disabled={!booted} command={{ type: "simulator.input", udid: device.udid, input: { kind: "button", button: "home" } }}><House size={16} /></CommandButton>
            <CommandButton type="button" aria-label="Lock" data-tip="Lock" disabled={!booted} command={{ type: "simulator.input", udid: device.udid, input: { kind: "button", button: "lock" } }}><Lock size={16} /></CommandButton>
          </>
        )}
      </header>
      <div className="simulator-stage">
        {body}
        {booted && (
          <canvas
            ref={canvas}
            className={`simulator-screen ${driving ? "driven" : ""}`.trimEnd()}
            style={screenStyle}
            hidden={!size}
            tabIndex={0}
            aria-label={`${device.name} screen`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.focus({ preventScroll: true });
              send({ kind: "touch", phase: "down", ...position(event) });
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) send({ kind: "touch", phase: "move", ...position(event) });
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              event.currentTarget.releasePointerCapture(event.pointerId);
              send({ kind: "touch", phase: "up", ...position(event) });
            }}
            onPointerCancel={(event) => send({ kind: "touch", phase: "up", ...position(event) })}
            onKeyDown={(event) => onKey(event, true)}
            onKeyUp={(event) => onKey(event, false)}
            onBlur={release}
          />
        )}
        {booted && stream.error && <Notice tone="error" icon={<AlertTriangle size={18} />} title={`Could not show ${device.name}`} detail={stream.error}
          action={<button type="button" onClick={stream.retry}>Try again</button>} />}
        {booted && !size && !stream.error && <Notice icon={<SpinningIcon icon={Smartphone} spinning size={18} />} title={`Connecting to ${device.name}`} />}
      </div>
    </section>
  );
}
