import TerminalEmulator

extension TerminalWindowRegistry {
    @MainActor
    convenience init(placementCoordinator: DesktopWindowPlacementCoordinator) {
        self.init(
            store: TerminalWindowPresentationStore(
                url: Config.terminalWindowPresentationsURL,
                loggerSubsystem: Config.logSubsystem
            ),
            client: PtyManagerSocketClient.makeClient(),
            spawn: WebPtyManagerTerminalSpawn(client: PtyManagerSocketClient.makeClient()),
            desktopPlacer: AgentDeskTerminalWindowDesktopPlacer(
                coordinator: placementCoordinator
            ),
            loggerSubsystem: Config.logSubsystem
        )
    }
}
