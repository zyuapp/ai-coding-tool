# How we work
- We are the sole owners of the codebase. No need to make branches for any changes. We are allowed to make quick changes and push them directly to the main branch.
- I often ask you to make multiple changes on the main branch in different thread so only commit the changes that are requested in the thread.

# Architecture intent

The app has one control path for people and agents.
- Every interaction is an `AppCommand`.
- `reduce(state, input)` is the only writer of workspace state.
- The reducer describes external work as effects.
- `useTaskWorkspace` performs effects and returns results as `WorkspaceEvent` values.
- Components display state and dispatch commands. They contain no behaviour.
- External commands must pass validation before they reach the reducer.

## Add a feature
1. Define an `AppCommand` or `WorkspaceEvent`.
2. Handle it in the reducer.
3. Return an effect for external work.
4. Run the effect in `useTaskWorkspace`.
5. Return the result as a `WorkspaceEvent`.
6. Test the behaviour in `tests/workspace-reducer.test.mjs`.
7. Add an `actions` shorthand only when a component needs it.

If the reducer cannot express a UI action, an agent cannot perform it.