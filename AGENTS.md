# AI Coding Tool
This app is designed to make it easier for people and agents to work together. For now, I’m building it only for macOS and Claude models because I don’t want to support platforms or models I don’t use every day. Still, structure the app so we can add other operating systems and model providers later without major changes. Push back if I suggest anything that would make future expansion harder.

# What do I value
1. Simplicity. The app should feel obvious. Users should understand each feature without having to stop and figure it out. Avoid lengthy explanations, especially in Settings. If a feature needs too much explanation, simplify the feature.
2. Performance. The app must remain fast and responsive under heavy use. UI responsiveness, memory efficiency, and backend speed are core requirements. Design for worst-case workloads, and do not dismiss early optimization when bottlenecks are predictable.
3. Beauty. The app should be visually polished and enjoyable to use. Every interaction should feel thoughtful. I want people to find joy in using it, not merely tolerate it.
4. User experience. Every feature affects the app as a whole, no matter how small it seems. Before adding one, consider how it will change existing features and interactions. The result should make the app easier to use, never feel bolted on.

# How we work
1. We have sole ownership of this codebase, so do not create branches. Work directly on main, then commit your changes when finished, even if you could not verify them.
2. I often request unrelated changes to main in multiple threads at the same time. Commit only the changes requested in the current thread, and leave all other work untouched.
3. I use this AGENTS.md to define what matters for the project. Do not edit it unless I explicitly ask you to.
4. Keep HTML mockups out of the repository. Write them to /tmp and serve them from there.
5. Do not check in non-code related documents into this repo.

# Architecture intent
The app has one control path for people and agents. This makes adding MCP tools and different frontends such as mobile and tablet easier without reinventing the backend.
- Every interaction is an `AppCommand`.
- `reduce(state, input)` is the only writer of workspace state.
- The reducer describes external work as effects.
- `useTaskWorkspace` performs effects and returns results as `WorkspaceEvent` values.
- Components display state and dispatch commands. They contain no behaviour.
- External commands must pass validation before they reach the reducer.
