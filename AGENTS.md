# AI Coding Tool
This app is currently a clone of the Codex desktop app with the features I find useful. It is build only for Mac and Claude models in mind because I don't want to add support for something that I don't use everyday. However, it is still very important to structure the app in a way to make it easy to support different platforms and providers, so I need you to push back if I suggest something that makes it difficult for future expansion. 

# How we work
- We are the sole owners of the codebase. No need to make branches for any changes. We are allowed to make quick changes and push them directly to the main branch. Commit your work when you are done even if it is not verified. 
- I often ask you to make multiple changes on the main branch in different thread so only commit the changes that are requested in the thread.
- This AGENTS.md is for me to decide what is important and what is not. You should not make any changes to it unless I ask you to do so.
- Keep HTML mock-ups out of the repo. Write them under `/tmp` and serve them from there.

# Architecture intent
The app has one control path for people and agents. This makes adding MCP tools and different frontends such as mobile and tablet easier without reinventing the backend.
- Every interaction is an `AppCommand`.
- `reduce(state, input)` is the only writer of workspace state.
- The reducer describes external work as effects.
- `useTaskWorkspace` performs effects and returns results as `WorkspaceEvent` values.
- Components display state and dispatch commands. They contain no behaviour.
- External commands must pass validation before they reach the reducer.
