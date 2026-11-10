/**
 * One capability's part of the desktop API, split by who reaches each member. A member the runtime and
 * a window both call is in both parts.
 */
export type DesktopPort = {
  /** What the workspace runtime calls, in the desktop app or on a headless server. */
  runtime?: object;
  /** What a window's own views call, each relayed to main by name. */
  windowCalls?: object;
  /** What a window has without calling main: main's pushes, and what the preload answers itself. */
  windowOwn?: object;
};

type Part<Port, Key extends keyof DesktopPort> = Port extends { [Name in Key]: infer Members } ? Members : unknown;

/** One part of every port, as a single type. */
export type JoinedPorts<Ports extends readonly DesktopPort[], Key extends keyof DesktopPort> =
  Ports extends readonly [infer First, ...infer Rest extends readonly DesktopPort[]] ? Part<First, Key> & JoinedPorts<Rest, Key> : unknown;

/** Every member of the ports, whoever reaches it. */
export type PortMembers<Ports extends readonly DesktopPort[]> = JoinedPorts<Ports, "runtime"> & JoinedPorts<Ports, "windowCalls"> & JoinedPorts<Ports, "windowOwn">;
