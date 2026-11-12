import { useRef, type CSSProperties, type ReactNode } from "react";
import { LuHouse as House, LuLock as Lock, LuRotateCcw as RotateLeft, LuRotateCw as RotateRight, LuSmartphone as Smartphone, LuTriangleAlert as AlertTriangle } from "react-icons/lu";
import { screenCornerRadius, screenTurns, turned, type SimulatorInput, type SimulatorOrientation, type SimulatorState } from "../../domain/simulator";
import { useSimulatorStream } from "../simulator/use-simulator-stream";
import { useScreenInput } from "../simulator/use-screen-input";
import { CommandButton, CommandIconButton } from "./CommandControl";
import { SimulatorDeviceMenu } from "./SimulatorDeviceMenu";
import { SpinningIcon } from "./SpinningIcon";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Toolbar } from "../ui/PanelHeader";
import "../ui/glass.css";

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

function Notice({ icon, title, detail, action, tone }: { icon: ReactNode; title: string; detail?: string; action?: ReactNode; tone?: "danger" }) {
  return <EmptyState className="simulator-notice" role={tone === "danger" ? "alert" : "status"} tone={tone} icon={icon} title={title} detail={detail} action={action} />;
}

/** The screen's shape as it is shown, its corners, and how the picture turns to read upright. */
function screenStyle(size: { width: number; height: number }, name: string, orientation: SimulatorOrientation): CSSProperties {
  const sideways = screenTurns(orientation) % 2 === 1;
  const shown = sideways ? { width: size.height, height: size.width } : size;
  const corner = screenCornerRadius(name) * Math.min(size.width, size.height);
  return {
    "--simulator-aspect": `${shown.width / shown.height}`,
    "--simulator-turn": `${screenTurns(orientation) * 90}deg`,
    borderRadius: `${corner / shown.width * 100}% / ${corner / shown.height * 100}%`,
  } as CSSProperties;
}

export function SimulatorPanel({ simulator, udid, active, openMenu, onSetOpenMenu, onInput }: SimulatorPanelProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const device = simulator.devices.find((item) => item.udid === udid);
  const orientation = (device && simulator.orientations[device.udid]) ?? "portrait";
  const booted = device?.state === "booted";
  const stream = useSimulatorStream(canvas, active && booted ? device.udid : null);
  const size = stream.error ? null : stream.size;
  const driving = Boolean(device && simulator.driver?.udid === device.udid);
  const error = device ? simulator.errors[device.udid] : undefined;
  const booting = device ? simulator.booting.includes(device.udid) || device.state === "booting" : false;

  const screen = useScreenInput(device?.udid ?? null, orientation, onInput);

  let body: ReactNode;
  if (simulator.availability.status === "unsupported") {
    body = <Notice icon={<Smartphone size={18} />} title="Simulator unavailable" detail={simulator.availability.reason} />;
  } else if (!device) {
    body = <Notice icon={<SpinningIcon icon={Smartphone} spinning={simulator.availability.status === "unknown"} size={18} />} title={simulator.availability.status === "unknown" ? "Looking for simulators" : "No simulators"} detail={simulator.availability.status === "unknown" ? undefined : "Add an iOS simulator in Xcode, then open this panel again."} />;
  } else if (error && !booting) {
    body = <Notice tone="danger" icon={<AlertTriangle size={18} />} title={`${device.name} could not start`} detail={error}
      action={<CommandButton variant="soft" size="lg" command={{ type: "simulator.select", udid: device.udid }}>Try again</CommandButton>} />;
  } else if (!booted) {
    body = booting
      ? <Notice icon={<SpinningIcon icon={Smartphone} spinning size={18} />} title={`Starting ${device.name}`} detail="It runs in the background, so you can keep working." />
      : <Notice icon={<Smartphone size={18} />} title={`${device.name} is off`}
        action={<CommandButton variant="soft" size="lg" command={{ type: "simulator.select", udid: device.udid }}>Start</CommandButton>} />;
  }

  return (
    <section className="simulator-panel" aria-label="Simulator">
      <header>
        <Toolbar className="simulator-bar">
          <SimulatorDeviceMenu devices={simulator.devices} availability={simulator.availability} selected={device} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />
          {driving && <span className="simulator-driving raised" role="status"><i aria-hidden="true" />Agent is using this device</span>}
          <span className="simulator-bar-gap" />
          {device && (
            <>
              <CommandIconButton label="Rotate left" disabled={!booted} command={{ type: "simulator.input", udid: device.udid, input: { kind: "rotate", orientation: turned(orientation, -1) } }}><RotateLeft size={16} aria-hidden="true" /></CommandIconButton>
              <CommandIconButton label="Rotate right" disabled={!booted} command={{ type: "simulator.input", udid: device.udid, input: { kind: "rotate", orientation: turned(orientation, 1) } }}><RotateRight size={16} aria-hidden="true" /></CommandIconButton>
              <CommandIconButton label="Home" disabled={!booted} command={{ type: "simulator.input", udid: device.udid, input: { kind: "button", button: "home" } }}><House size={16} aria-hidden="true" /></CommandIconButton>
              <CommandIconButton label="Lock" disabled={!booted} command={{ type: "simulator.input", udid: device.udid, input: { kind: "button", button: "lock" } }}><Lock size={16} aria-hidden="true" /></CommandIconButton>
            </>
          )}
        </Toolbar>
      </header>
      <div className="simulator-stage">
        {body}
        {booted && (
          <div
            className={["simulator-screen", driving ? "driven" : "", screenTurns(orientation) % 2 ? "sideways" : ""].filter(Boolean).join(" ")}
            style={size ? screenStyle(size, device.name, orientation) : undefined}
            hidden={!size}
            tabIndex={0}
            role="application"
            aria-label={`${device.name} screen`}
            {...screen.handlers}
          >
            <canvas ref={canvas} />
            <div ref={screen.fingerMarks} className="simulator-fingers" aria-hidden="true" hidden><i /><i /></div>
          </div>
        )}
        {booted && stream.error && <Notice tone="danger" icon={<AlertTriangle size={18} />} title={`Could not show ${device.name}`} detail={stream.error}
          action={<Button variant="soft" size="lg" onClick={stream.retry}>Try again</Button>} />}
        {booted && !size && !stream.error && <Notice icon={<SpinningIcon icon={Smartphone} spinning size={18} />} title={`Connecting to ${device.name}`} />}
      </div>
    </section>
  );
}
