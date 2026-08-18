# How we work
- We are the sole owners of the codebase. No need to make branches for any changes. We are allowed to make quick changes and push them directly to the main branch.

# Architecture intent

Everything this app can do should be drivable by an agent, not only by a mouse. That is why state is
shaped the way it is:

- **Interactions are values.** Every one is a case of `AppCommand` in `src/contracts/commands.ts`.
  Components never mutate state; they dispatch a command.
- **One writer.** `reduce(state, input)` in `src/application/workspace-reducer.ts` is the only place
  workspace state changes. It returns the next state plus the effects it wants performed, and imports
  nothing from Electron or the DOM, so it can be hosted outside the renderer later.
- **Effects are data.** `useTaskWorkspace` is the only thing that performs them. Whatever comes back
  re-enters through the same reducer as a `WorkspaceEvent`.
- **Layers.** `domain/` types and validators, `application/` state and behaviour, `contracts/`
  boundary shapes, `main/` services and IPC, `renderer/` React only.

## Adding a feature

1. Add an `AppCommand` case, or a `WorkspaceEvent` if the outside world is reporting back.
2. Handle it in `reduce`. Return an effect instead of doing IO there.
3. Perform the effect in the hook's effect runner and dispatch an event with the result.
4. Test it against the reducer in `tests/workspace-reducer.test.mjs`, not through React.
5. Add a shorthand to `actions` only if a component needs one.

Behaviour never belongs in a component or in the hook. If the UI can do something the reducer cannot
express as a command, an agent will not be able to do it either.

Commands arriving from outside the window — an agent tool, IPC — must be validated at that boundary
before they reach `reduce`, the way `isRunCommand` guards the run channel.
