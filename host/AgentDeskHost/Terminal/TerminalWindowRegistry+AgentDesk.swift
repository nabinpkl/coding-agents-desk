import TerminalEmulator

extension TerminalWindowRegistry {
    @MainActor
    convenience init() {
        self.init(
            store: TerminalWindowPresentationStore(url: Config.terminalWindowPresentationsURL),
            client: PtyManagerSocketClient.makeClient(),
            spawn: SwiftTermPtyManagerTerminalSpawn(client: PtyManagerSocketClient.makeClient()),
            loggerSubsystem: Config.logSubsystem
        )
    }
}
