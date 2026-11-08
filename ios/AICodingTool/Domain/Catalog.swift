import Foundation

/// One model as a picker offers it.
struct ModelSpec: Equatable, Sendable {
    var id: String
    var label: String
    var description: String
    var provider: String?
    var efforts: [MobileEffortTerm]
}

/// One heading of the model picker: an engine's models, or one provider's for an engine that runs many.
struct ModelHeading: Equatable, Sendable {
    var key: String
    var engine: String
    var label: String
    var first: Bool
    var models: [ModelSpec]
    /// Another engine than a settled thread's, which only a new thread reaches.
    var locked: Bool
}

/// The computer's engines as the phone's pickers read them, from what the computer sent and what its
/// build calls things. Ported from `mobileEngineView` and `modelLibrary`.
struct EngineCatalog: Equatable, Sendable {
    var vocabulary: MobileVocabulary?
    var engines: [String: MobileEngine]

    var engineIds: [String] { vocabulary?.engines.map(\.id) ?? ["claude", "codex", "opencode"] }

    func terms(_ engine: String) -> MobileEngineTerms? {
        vocabulary?.engines.first { $0.id == engine }
    }

    func knows(_ engine: String) -> Bool { terms(engine) != nil }

    func engineLabel(_ engine: String) -> String {
        terms(engine)?.label ?? Self.fallbackLabels[engine] ?? engine
    }

    func fastMode(_ engine: String) -> Bool { terms(engine)?.fastMode ?? false }

    func policies(_ engine: String) -> [MobilePolicyTerm] { terms(engine)?.policies ?? [] }

    func policyLabel(_ policy: String) -> String {
        for engine in vocabulary?.engines ?? [] {
            if let term = engine.policies.first(where: { $0.id == policy }) { return term.label }
        }
        return Self.fallbackPolicies[policy] ?? policy
    }

    /// Every role a thread may take, in menu order.
    var roles: [MobileRoleTerm] { vocabulary?.roles ?? Self.fallbackRoles }

    func effort(_ id: String) -> MobileEffortTerm {
        vocabulary?.efforts.first { $0.id == id } ?? MobileEffortTerm(id: id, label: Self.fallbackEfforts[id] ?? id.capitalized)
    }

    /// Every effort, deepest first, which is the order a clamp walks.
    private var effortOrder: [String] { vocabulary?.efforts.map(\.id) ?? ["ultra", "max", "xhigh", "high", "medium", "low"] }

    /// The engine's models: what it sent of its own, else what its build ships knowing.
    func models(_ engine: String) -> [ModelSpec] {
        let sent = engines[engine]
        let listed = sent?.catalog ?? terms(engine)?.models ?? []
        return listed.map { model in
            ModelSpec(id: model.id, label: model.label, description: model.description, provider: model.provider, efforts: effortOrder.filter(model.efforts.contains).map(effort))
        }
    }

    func access(_ engine: String) -> String { engines[engine]?.access ?? "ready" }

    func model(_ engine: String, _ id: String?) -> ModelSpec? {
        guard let id else { return nil }
        return models(engine).first { $0.id == id }
    }

    func efforts(_ engine: String, model: String, coordinating: Bool) -> [MobileEffortTerm] {
        let offered = self.model(engine, model)?.efforts ?? []
        return coordinating ? offered.filter { $0.delegates != true } : offered
    }

    /// The effort a model runs at for the one asked: the same, or the nearest shallower it takes.
    func effortForModel(_ engine: String, model: String, effort: String, coordinating: Bool) -> String {
        guard let asked = effortOrder.firstIndex(of: effort) else { return effort }
        let offered = efforts(engine, model: model, coordinating: coordinating)
        if offered.isEmpty || offered.contains(where: { $0.id == effort }) { return effort }
        return (offered.first { (effortOrder.firstIndex(of: $0.id) ?? 0) >= asked } ?? offered[offered.count - 1]).id
    }

    /// The picker's headings, each engine's models under their providers where they name one.
    func library(engine current: String, locked: Bool) -> [ModelHeading] {
        engineIds.flatMap { engine -> [ModelHeading] in
            let installed = engines[engine]?.models
            var providers: [(String, [ModelSpec])] = []
            for spec in models(engine) where installed == nil || installed!.contains(spec.id) {
                let provider = spec.provider ?? ""
                if let index = providers.firstIndex(where: { $0.0 == provider }) { providers[index].1.append(spec) } else { providers.append((provider, [spec])) }
            }
            if providers.isEmpty { providers = [("", [])] }
            return providers.enumerated().map { index, entry in
                ModelHeading(key: entry.0.isEmpty ? engine : "\(engine):\(entry.0)", engine: engine, label: entry.0.isEmpty ? engineLabel(engine) : entry.0, first: index == 0, models: entry.1, locked: locked && engine != current)
            }
        }
    }

    /// A thread's settings as the composer's bottom edge reads them. Effort is nil for a model that takes none.
    func summary(_ settings: MobileThreadSettings) -> (mode: String, model: String, effort: String?) {
        let spec = knows(settings.engine) ? model(settings.engine, settings.model) : nil
        let fast = fastMode(settings.engine) && settings.fastMode == true ? " · Fast" : ""
        let modelName = (spec?.label ?? settings.model ?? "No model") + fast
        var effort: String?
        if let spec {
            let resolved = effortForModel(settings.engine, model: spec.id, effort: settings.effort, coordinating: false)
            effort = spec.efforts.first { $0.id == resolved }?.label
            if effort == nil, !effortOrder.contains(settings.effort) { effort = settings.effort }
        } else {
            effort = settings.effort
        }
        return (policyLabel(settings.policy), modelName, effort)
    }

    private static let fallbackLabels = ["claude": "Claude", "codex": "Codex", "opencode": "OpenCode"]
    private static let fallbackPolicies = ["autonomous": "Auto", "bypass": "Bypass", "allow-edits": "Edits", "confirm": "Confirm", "plan": "Plan"]
    private static let fallbackRoles = [("coordinator", "Coordinator"), ("implementer", "Implementer"), ("reviewer", "Reviewer"), ("researcher", "Researcher")].map { MobileRoleTerm(id: $0.0, label: $0.1) }
    private static let fallbackEfforts = ["ultra": "Ultra", "max": "Max", "xhigh": "Extra high", "high": "High", "medium": "Medium", "low": "Low"]
}
