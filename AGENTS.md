# How we work
- We are the sole owners of the codebase. No need to make branches for any changes. We are allowed to make quick changes and push them directly to the main branch. Commit your work when you are done even if it is not verified. 
- I often ask you to make multiple changes on the main branch in different thread so only commit the changes that are requested in the thread.
- This AGENTS.md is for me to decide what is important and what is not. You should not make any changes to it unless I ask you to do so.
- Keep HTML mock-ups out of the repo. Write them under `/tmp` and serve them from there.
- Run Electron from the repo root only. Pointed anywhere else, npx installs a second Electron that steals the `aicodingtool:` scheme.

# Architecture intent

The app has one control path for people and agents.
- Every interaction is an `AppCommand`.
- `reduce(state, input)` is the only writer of workspace state.
- The reducer describes external work as effects.
- `useTaskWorkspace` performs effects and returns results as `WorkspaceEvent` values.
- Components display state and dispatch commands. They contain no behaviour.
- External commands must pass validation before they reach the reducer.
