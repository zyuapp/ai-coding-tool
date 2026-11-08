import Foundation

/// What a tool call reads as, ported from `src/domain/tool-call.ts`.
enum ToolFamily: String, Sendable {
    case shell, read, write, search, web, agent, thread, automation, other

    var symbol: String {
        switch self {
        case .shell: "terminal"
        case .read: "doc.text"
        case .write: "pencil.line"
        case .search: "magnifyingglass"
        case .web: "globe"
        case .agent: "cpu"
        case .thread: "bubble.left.and.bubble.right"
        case .automation: "bell"
        case .other: "wrench.adjustable"
        }
    }
}

enum ToolNames {
    private static let families: [String: [String: ToolFamily]] = [
        "claude": [
            "Bash": .shell, "BashOutput": .shell, "KillShell": .shell,
            "Read": .read, "NotebookRead": .read,
            "Write": .write, "Edit": .write, "MultiEdit": .write, "NotebookEdit": .write,
            "Grep": .search, "Glob": .search, "ToolSearch": .search,
            "WebFetch": .web, "WebSearch": .web,
            "Agent": .agent, "Task": .agent, "Skill": .agent, "Workflow": .agent, "SendMessage": .agent,
        ],
        "codex": [
            "command_execution": .shell, "file_change": .write, "web_search": .web, "mcp_tool_call": .other,
        ],
        "opencode": [
            "shell": .shell, "read": .read,
            "write": .write, "edit": .write, "apply_patch": .write, "patch": .write, "multiedit": .write,
            "glob": .search, "grep": .search, "list": .search,
            "webfetch": .web, "websearch": .web,
            "subagent": .agent, "task": .agent, "skill": .agent,
        ],
    ]

    /// The app's own tools, which carry the same names whichever engine calls them.
    private static let own: [String: (ToolFamily, String)] = [
        "list_threads": (.thread, "List threads"),
        "read_thread": (.thread, "Read thread"),
        "wait_for_thread": (.thread, "Wait for thread"),
        "start_thread": (.thread, "Start thread"),
        "message_thread": (.thread, "Message thread"),
        "set_thread_role": (.thread, "Set role"),
        "archive_thread": (.thread, "Archive thread"),
        "stop_thread": (.thread, "Stop thread"),
        "move_to_worktree": (.thread, "Move to worktree"),
        "delete_worktree": (.thread, "Delete worktree"),
        "report_status": (.thread, "Report status"),
        "raise_decision": (.thread, "Ask for a decision"),
        "remember": (.thread, "Remember"),
        "forget": (.thread, "Forget"),
        "set_purpose": (.thread, "Set purpose"),
        "propose_threads": (.thread, "Propose threads"),
        "notify": (.automation, "Notify"),
        "nothing_to_report": (.automation, "Nothing to report"),
        "schedule": (.automation, "Schedule"),
        "status": (.automation, "Automation status"),
        "update": (.automation, "Update automation"),
        "stop": (.automation, "Stop automation"),
        "list_all": (.automation, "List automations"),
        "terminal_list": (.read, "List terminals"),
        "terminal_read": (.read, "Read terminal"),
        "browser_open": (.web, "Open page"),
        "browser_search": (.web, "Search"),
        "browser_read": (.web, "Read page"),
        "browser_screenshot": (.web, "Screenshot"),
        "browser_console": (.web, "Console"),
        "browser_network": (.web, "Network"),
        "browser_wait": (.web, "Wait"),
        "browser_click": (.web, "Click"),
        "browser_type": (.web, "Type"),
        "browser_back": (.web, "Back"),
        "browser_tabs": (.web, "List tabs"),
        "browser_close_tab": (.web, "Close tab"),
        "request_setup": (.other, "Set up computer use"),
    ]

    /// `mcp__server__tool` split into its server and tool.
    private static func mcp(_ name: String) -> (server: String, tool: String)? {
        guard name.hasPrefix("mcp__") else { return nil }
        let rest = name.dropFirst(5)
        guard let split = rest.range(of: "__"), split.lowerBound != rest.startIndex else { return nil }
        let tool = rest[split.upperBound...]
        guard !tool.isEmpty else { return nil }
        return (String(rest[..<split.lowerBound]), String(tool))
    }

    private static func ownTool(_ name: String) -> (ToolFamily, String)? {
        if let call = mcp(name) {
            guard call.server == "aicodingtool" || call.server.hasPrefix("aicodingtool-") else { return nil }
            return own[call.tool]
        }
        return own[name]
    }

    static func label(_ name: String) -> String {
        if let tool = ownTool(name) { return tool.1 }
        if let call = mcp(name) { return "\(call.server) · \(call.tool.replacingOccurrences(of: "_", with: " "))" }
        return name
    }

    static func family(engine: String, _ name: String) -> ToolFamily {
        if let family = families[engine]?[name] { return family }
        if let tool = ownTool(name) { return tool.0 }
        return name.hasPrefix("browser_") ? .web : .other
    }
}
