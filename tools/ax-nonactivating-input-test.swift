#!/usr/bin/env swift

import AppKit
import ApplicationServices
import Foundation

// Non-activating AX input harness for a backgrounded Claude Desktop window.
//
// Sequence per run:
//   resolve    -> locate the Claude window on the target Space (yabai)
//   setup-ax   -> latch Chromium's full AX tree (AXManualAccessibility)
//   move-in    -> move that window onto the current Space WITHOUT focusing it (yabai)
//   materialize-> wait until the composer AXTextArea appears in the tree
//   write      -> AXUIElementSetAttributeValue on the composer (no focus, no events)
//   verify     -> read the composer value back
//   move-back  -> move the window back to its Space, still without focusing
// The app is never activated; frontmost must not change across the run.

let targetSpace = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 4 : 4
let runs = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 1 : 1
let text = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "AGENTDESK-AX-TEST-MARKER"

func ms(_ start: TimeInterval) -> Int {
    Int((Date().timeIntervalSince1970 - start) * 1000)
}

func runYabai(_ args: [String]) -> Data? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = ["yabai", "-m"] + args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    guard (try? p.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? data : nil
}

func yabaiWindows() -> [[String: Any]] {
    guard let data = runYabai(["query", "--windows"]),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        return []
    }
    return parsed
}

func currentSpace() -> Int? {
    for w in yabaiWindows() where (w["has-focus"] as? Bool) == true {
        return w["space"] as? Int
    }
    return nil
}

func claudeWindow(on space: Int) -> (pid: pid_t, windowID: Int)? {
    for w in yabaiWindows() {
        if (w["app"] as? String) == "Claude",
           (w["space"] as? Int) == space,
           let pid = w["pid"] as? Int,
           let windowID = w["id"] as? Int {
            return (pid_t(pid), windowID)
        }
    }
    return nil
}

func axAttr<T>(_ el: AXUIElement, _ name: String) -> T? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
    return v as? T
}

func strAttr(_ el: AXUIElement, _ name: String) -> String { axAttr(el, name) ?? "" }

func related(_ el: AXUIElement) -> [AXUIElement] {
    var out: [AXUIElement] = []
    if let c: [AXUIElement] = axAttr(el, kAXChildrenAttribute) { out += c }
    if let c: [AXUIElement] = axAttr(el, "AXChildrenInNavigationOrder") { out += c }
    if strAttr(el, kAXRoleAttribute as String) == kAXApplicationRole {
        if let w: [AXUIElement] = axAttr(el, kAXWindowsAttribute) { out += w }
        if let w: AXUIElement = axAttr(el, kAXFocusedWindowAttribute) { out.append(w) }
        if let w: AXUIElement = axAttr(el, kAXMainWindowAttribute) { out.append(w) }
    }
    return out
}

func findComposer(pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    var visited: Set<UInt> = []
    var hit: AXUIElement?
    func find(_ el: AXUIElement, _ depth: Int) {
        let h = CFHash(el)
        guard visited.insert(h).inserted, depth < 100, hit == nil else { return }
        let role = strAttr(el, kAXRoleAttribute as String)
        if role == kAXTextAreaRole || role == kAXTextFieldRole {
            hit = el
            return
        }
        for c in related(el) { find(c, depth + 1) }
    }
    find(app, 0)
    return hit
}

func frontmostName() -> String? {
    NSWorkspace.shared.frontmostApplication?.localizedName
}

func latchFullAX(pid: pid_t) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    return AXUIElementSetAttributeValue(
        app,
        "AXManualAccessibility" as CFString,
        kCFBooleanTrue
    ) == .success
}

guard AXIsProcessTrusted() else {
    fputs("Missing Accessibility permission\n", stderr)
    exit(64)
}

var phaseTimes: [[String: Int]] = []
print("targetSpace=\(targetSpace) runs=\(runs) text=[\(text)] frontmostBefore=\(frontmostName() ?? "?")")

for run in 1...runs {
    var t: [String: Int] = [:]
    let runStart = Date().timeIntervalSince1970

    let tResolve = Date().timeIntervalSince1970
    guard let target = claudeWindow(on: targetSpace) else {
        fputs("run \(run): no Claude window on space \(targetSpace)\n", stderr)
        exit(1)
    }
    guard let homeSpace = currentSpace(), homeSpace != targetSpace else {
        fputs("run \(run): cannot determine current space or it equals target\n", stderr)
        exit(1)
    }
    t["resolve"] = ms(tResolve)

    let tAX = Date().timeIntervalSince1970
    _ = latchFullAX(pid: target.pid)
    t["setup-ax"] = ms(tAX)

    let frontmostBefore = frontmostName()

    let tMoveIn = Date().timeIntervalSince1970
    guard runYabai(["window", String(target.windowID), "--space", String(homeSpace)]) != nil else {
        fputs("run \(run): yabai move-in failed\n", stderr)
        exit(1)
    }
    t["move-in"] = ms(tMoveIn)

    let tMaterialize = Date().timeIntervalSince1970
    var composer: AXUIElement?
    let materializeDeadline = Date().addingTimeInterval(10)
    while Date() < materializeDeadline {
        if let hit = findComposer(pid: target.pid) {
            composer = hit
            break
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    t["materialize"] = ms(tMaterialize)
    guard let composer else {
        fputs("run \(run): composer never materialized after move-in\n", stderr)
        _ = runYabai(["window", String(target.windowID), "--space", String(targetSpace)])
        continue
    }

    let tWrite = Date().timeIntervalSince1970
    let writeError = AXUIElementSetAttributeValue(
        composer,
        kAXValueAttribute as CFString,
        text as CFString
    )
    t["write"] = ms(tWrite)
    guard writeError == .success else {
        fputs("run \(run): write failed err=\(writeError.rawValue)\n", stderr)
        _ = runYabai(["window", String(target.windowID), "--space", String(targetSpace)])
        continue
    }

    let tVerify = Date().timeIntervalSince1970
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    let after: String = strAttr(composer, kAXValueAttribute as String)
    t["verify"] = ms(tVerify)

    let tMoveBack = Date().timeIntervalSince1970
    _ = _ = runYabai(["window", String(target.windowID), "--space", String(targetSpace)])
    t["move-back"] = ms(tMoveBack)

    let frontmostAfter = frontmostName()
    let ok = after == text && frontmostBefore == frontmostAfter
    t["total"] = ms(runStart)
    phaseTimes.append(t)

    print(
        "run \(run): resolve=\(t["resolve"] ?? -1)ms setup-ax=\(t["setup-ax"] ?? -1)ms "
            + "move-in=\(t["move-in"] ?? -1)ms materialize=\(t["materialize"] ?? -1)ms "
            + "write=\(t["write"] ?? -1)ms verify=\(t["verify"] ?? -1)ms "
            + "move-back=\(t["move-back"] ?? -1)ms total=\(t["total"] ?? -1)ms "
            + "ok=\(ok) value=[\(after.prefix(30))] focus:\(frontmostBefore ?? "?")->\(frontmostAfter ?? "?")"
    )
}

if phaseTimes.count > 1 {
    let keys = ["resolve", "setup-ax", "move-in", "materialize", "write", "verify", "move-back", "total"]
    print("-- averages over \(phaseTimes.count) runs --")
    for key in keys {
        let values = phaseTimes.compactMap { $0[key] }
        guard !values.isEmpty else { continue }
        let avg = values.reduce(0, +) / values.count
        let mn = values.min() ?? 0
        let mx = values.max() ?? 0
        print("  \(key): avg=\(avg)ms min=\(mn)ms max=\(mx)ms")
    }
}
